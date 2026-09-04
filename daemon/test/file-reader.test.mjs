import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseRemoteCommand, serializeCommand } from '@cursor-remote/protocol';

import {
  Daemon,
  FileReadError,
  FileReader,
  MAX_FILE_READ_BYTES,
  MAX_FILE_READ_PATH_CHARS,
  WorkspaceManager,
  WorkspaceNotFoundError,
  readWorkspaceFile,
} from '../dist/index.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-acp.mjs');

function mockLaunch() {
  return {
    command: process.execPath,
    args: [fixture],
  };
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'file-read-'));
}

function tryFileLink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

function fileReadCommand(sessionId, filePath, extra = {}) {
  return parseRemoteCommand(
    serializeCommand({
      requestId: `req-file-${filePath}`,
      sessionId,
      timestamp: new Date().toISOString(),
      type: 'file.read',
      payload: { path: filePath, ...extra },
    }),
  );
}

function assertNoAbsolutePath(message, roots) {
  for (const root of roots) {
    assert.equal(message.includes(root), false, message);
  }
  assert.equal(/[A-Za-z]:[\\/]/.test(message), false, message);
  assert.equal(message.includes('\\'), false, message);
}

async function withDaemon(allowedRoot, fn) {
  const daemon = await Daemon.start({
    acp: {
      ...mockLaunch(),
      shutdownTimeoutMs: 1000,
    },
    workspaces: { allowedRoots: [allowedRoot] },
  });
  try {
    await fn(daemon);
  } finally {
    await daemon.stop();
  }
}

test('readWorkspaceFile returns utf8 content and ignores extra payload fields', async () => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'foo.ts'), 'export const n = 1;\n');
  const workspaces = new WorkspaceManager({ allowedRoots: [allowedRoot] });
  const registered = workspaces.register(project);
  const result = readWorkspaceFile(workspaces, registered.workspaceId, 'src/foo.ts');
  assert.deepEqual(result, {
    path: 'src/foo.ts',
    content: 'export const n = 1;\n',
    truncated: false,
  });
});

test('file.read rejects unsafe paths without returning content or absolute paths', async () => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'foo.ts'), 'ok\n');
  const workspaces = new WorkspaceManager({ allowedRoots: [allowedRoot] });
  const registered = workspaces.register(project);
  const roots = [allowedRoot, project];

  const invalid = [
    '',
    '.',
    '..',
    'src/../foo.ts',
    'src/./foo.ts',
    'src//foo.ts',
    '/etc/passwd',
    'C:/Windows/notepad.exe',
    'src\\foo.ts',
    'src/foo.ts:120',
    'src/foo.ts:120-160',
    `src/${'a'.repeat(MAX_FILE_READ_PATH_CHARS)}`,
    'src/foo.ts\0bar',
  ];
  for (const filePath of invalid) {
    assert.throws(
      () => readWorkspaceFile(workspaces, registered.workspaceId, filePath),
      FileReadError,
    );
    try {
      readWorkspaceFile(workspaces, registered.workspaceId, filePath);
    } catch (error) {
      assertNoAbsolutePath(error.message, roots);
    }
  }
});

test('missing, directory, sensitive, binary, and invalid utf8 files are errors', async () => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(project, 'src', 'nul.bin'), Buffer.from([0x61, 0x00, 0x62]));
  fs.writeFileSync(path.join(project, 'src', 'bad.txt'), Buffer.from([0xff, 0xfe, 0x00]));
  fs.writeFileSync(path.join(project, 'src', 'invalid.txt'), Buffer.from([0x80, 0x61]));
  const workspaces = new WorkspaceManager({ allowedRoots: [allowedRoot] });
  const registered = workspaces.register(project);
  const roots = [allowedRoot, project];

  const cases = ['src/missing.ts', 'src', '.env', 'src/nul.bin', 'src/bad.txt', 'src/invalid.txt'];
  for (const filePath of cases) {
    assert.throws(
      () => readWorkspaceFile(workspaces, registered.workspaceId, filePath),
      FileReadError,
    );
    try {
      readWorkspaceFile(workspaces, registered.workspaceId, filePath);
    } catch (error) {
      assert.equal('content' in error, false);
      assertNoAbsolutePath(error.message, roots);
    }
  }
});

test('file.read rejects private key basenames as sensitive', () => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'id_ed25519'), 'SECRET=1\n');
  const workspaces = new WorkspaceManager({ allowedRoots: [allowedRoot] });
  const registered = workspaces.register(project);
  assert.throws(
    () => readWorkspaceFile(workspaces, registered.workspaceId, 'id_ed25519'),
    FileReadError,
  );
  try {
    readWorkspaceFile(workspaces, registered.workspaceId, 'id_ed25519');
  } catch (error) {
    assert.equal('content' in error, false);
    assertNoAbsolutePath(error.message, [allowedRoot, project]);
  }
});

test('truncates at max bytes on a valid utf8 boundary', async () => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  fs.mkdirSync(project);
  const prefix = Buffer.alloc(MAX_FILE_READ_BYTES - 1, 0x61);
  fs.writeFileSync(
    path.join(project, 'big.txt'),
    Buffer.concat([prefix, Buffer.from('あ'), Buffer.from('z')]),
  );
  const workspaces = new WorkspaceManager({ allowedRoots: [allowedRoot] });
  const registered = workspaces.register(project);
  const result = readWorkspaceFile(workspaces, registered.workspaceId, 'big.txt');
  assert.equal(result.truncated, true);
  assert.equal(result.path, 'big.txt');
  assert.equal(result.content, 'a'.repeat(MAX_FILE_READ_BYTES - 1));
  assert.equal(Buffer.byteLength(result.content, 'utf8'), MAX_FILE_READ_BYTES - 1);
});

test('truncated invalid lead bytes are errors instead of stripped success', async () => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  fs.mkdirSync(project);
  const prefix = Buffer.alloc(MAX_FILE_READ_BYTES - 1, 0x61);
  const workspaces = new WorkspaceManager({ allowedRoots: [allowedRoot] });
  const registered = workspaces.register(project);
  const roots = [allowedRoot, project];
  const cases = [
    ['bad-ff.txt', Buffer.from([0xff, 0x78])],
    ['bad-c0.txt', Buffer.from([0xc0, 0x78])],
  ];
  for (const [name, suffix] of cases) {
    fs.writeFileSync(path.join(project, name), Buffer.concat([prefix, suffix]));
    assert.throws(() => readWorkspaceFile(workspaces, registered.workspaceId, name), FileReadError);
    try {
      readWorkspaceFile(workspaces, registered.workspaceId, name);
    } catch (error) {
      assert.equal('content' in error, false);
      assertNoAbsolutePath(error.message, roots);
    }
  }
});

test('truncates at a valid 4-byte utf8 boundary', async () => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  fs.mkdirSync(project);
  const prefix = Buffer.alloc(MAX_FILE_READ_BYTES - 1, 0x61);
  const fourByte = Buffer.from([0xf0, 0x9f, 0x98, 0x80]);
  fs.writeFileSync(
    path.join(project, 'emoji.txt'),
    Buffer.concat([prefix, fourByte, Buffer.from('z')]),
  );
  const workspaces = new WorkspaceManager({ allowedRoots: [allowedRoot] });
  const registered = workspaces.register(project);
  const result = readWorkspaceFile(workspaces, registered.workspaceId, 'emoji.txt');
  assert.equal(result.truncated, true);
  assert.equal(result.path, 'emoji.txt');
  assert.equal(result.content, 'a'.repeat(MAX_FILE_READ_BYTES - 1));
  assert.equal(Buffer.byteLength(result.content, 'utf8'), MAX_FILE_READ_BYTES - 1);
});

test('reads at most max plus one bytes and flags overflow from actual bytes', async () => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'cap.txt'), Buffer.alloc(MAX_FILE_READ_BYTES + 1, 0x61));
  const workspaces = new WorkspaceManager({ allowedRoots: [allowedRoot] });
  const registered = workspaces.register(project);
  const result = readWorkspaceFile(workspaces, registered.workspaceId, 'cap.txt');
  assert.equal(result.truncated, true);
  assert.equal(result.content, 'a'.repeat(MAX_FILE_READ_BYTES));
  assert.equal(Buffer.byteLength(result.content, 'utf8'), MAX_FILE_READ_BYTES);
});

test('in-root symlink to a regular non-sensitive file is allowed', async (t) => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'real.ts'), 'alias-ok\n');
  const linked = path.join(project, 'src', 'alias.ts');
  if (!tryFileLink(path.join(project, 'src', 'real.ts'), linked)) {
    t.skip('symlink is not available');
    return;
  }
  const workspaces = new WorkspaceManager({ allowedRoots: [allowedRoot] });
  const registered = workspaces.register(project);
  const result = readWorkspaceFile(workspaces, registered.workspaceId, 'src/alias.ts');
  assert.equal(result.path, 'src/real.ts');
  assert.equal(result.content, 'alias-ok\n');
  assert.equal(result.truncated, false);
});

test('symlink outside the workspace and symlink to a sensitive file are rejected', async (t) => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  const outsider = makeRoot();
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(outsider, 'secret.txt'), 'nope\n');
  fs.writeFileSync(path.join(project, '.env'), 'SECRET=1\n');
  const outsideLink = path.join(project, 'outside.txt');
  const sensitiveLink = path.join(project, 'harmless.txt');
  if (
    !tryFileLink(path.join(outsider, 'secret.txt'), outsideLink) ||
    !tryFileLink(path.join(project, '.env'), sensitiveLink)
  ) {
    t.skip('symlink is not available');
    return;
  }
  const workspaces = new WorkspaceManager({ allowedRoots: [allowedRoot] });
  const registered = workspaces.register(project);
  const roots = [allowedRoot, project, outsider];
  for (const filePath of ['outside.txt', 'harmless.txt']) {
    assert.throws(
      () => readWorkspaceFile(workspaces, registered.workspaceId, filePath),
      FileReadError,
    );
    try {
      readWorkspaceFile(workspaces, registered.workspaceId, filePath);
    } catch (error) {
      assertNoAbsolutePath(error.message, roots);
      assert.equal(error.message.includes('secret.txt'), false);
    }
  }
});

test('unknown workspace is a command error', async () => {
  const allowedRoot = makeRoot();
  const workspaces = new WorkspaceManager({ allowedRoots: [allowedRoot] });
  assert.throws(
    () => readWorkspaceFile(workspaces, 'missing-workspace', 'src/foo.ts'),
    WorkspaceNotFoundError,
  );
});

test('daemon file.read is session-bound, uses resolveTrustedPath, and does not emit file events', async () => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'foo.ts'), 'hello\n');
  await withDaemon(allowedRoot, async (daemon) => {
    const registered = daemon.workspaces.register(project);
    const created = await daemon.sessions.create({
      workspaceId: registered.workspaceId,
      initialPrompt: '',
      title: 'file',
    });
    assert.equal(
      daemon.sessions.workspaceIdForSession(created.remoteSessionId),
      registered.workspaceId,
    );
    const events = [];
    const stop = daemon.onEvent((event) => events.push(event));
    const result = await daemon.handleCommand(
      fileReadCommand(created.remoteSessionId, 'src/foo.ts', {
        workspaceId: 'other-ws',
        startLine: 12,
        endLine: 40,
        path2: '/etc/passwd',
      }),
    );
    stop();
    assert.deepEqual(result, {
      path: 'src/foo.ts',
      content: 'hello\n',
      truncated: false,
    });
    assert.equal(
      events.some((event) => event.type === 'file.reference' || event.type === 'file.content'),
      false,
    );
    assert.throws(
      () =>
        new FileReader(daemon.sessions, daemon.workspaces).handleCommand(
          fileReadCommand(null, 'src/foo.ts'),
        ),
      FileReadError,
    );
    await assert.rejects(daemon.handleCommand(fileReadCommand(null, 'src/foo.ts')), FileReadError);
  });
});
