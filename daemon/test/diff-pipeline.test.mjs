import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseRemoteCommand, serializeCommand } from '@cursor-remote/protocol';

import {
  Daemon,
  DiffPipeline,
  GitDiffError,
  MAX_DIFF_FILE_BYTES,
  MAX_DIFF_FILES,
  MAX_DIFF_PAYLOAD_BYTES,
  WorkspaceManager,
  WorkspaceNotFoundError,
} from '../dist/index.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-acp.mjs');

function mockLaunch() {
  return {
    command: process.execPath,
    args: [fixture],
  };
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diff-pipe-'));
}

function gitOk() {
  return spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

function initGit(dir) {
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'task301@example.com']);
  git(dir, ['config', 'user.name', 'task301']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
}

function tryFileLink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

function diffCommand(workspaceId, extra = {}) {
  return parseRemoteCommand(
    serializeCommand({
      requestId: `req-diff-${workspaceId}`,
      sessionId: null,
      timestamp: new Date().toISOString(),
      type: 'diff.read',
      payload: { workspaceId, ...extra },
    }),
  );
}

function createPipeline(allowedRoot) {
  const workspaces = new WorkspaceManager({ allowedRoots: [allowedRoot] });
  const pipeline = new DiffPipeline(workspaces);
  return { workspaces, pipeline };
}

function readDiff(pipeline, workspaceId, extra = {}) {
  const events = [];
  const stop = pipeline.onEvent((event) => events.push(event));
  try {
    const snapshot = pipeline.handleCommand(diffCommand(workspaceId, extra));
    const updated = events.filter((event) => event.type === 'diff.updated');
    assert.equal(updated.length, 1);
    assert.equal(updated[0].sessionId, null);
    assert.deepEqual(updated[0].payload, snapshot);
    return snapshot;
  } finally {
    stop();
  }
}

function fileNamed(snapshot, relativePath) {
  return snapshot.files.find((file) => file.path === relativePath);
}

test('non-Git workspace returns an empty successful snapshot', () => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'plain');
  fs.mkdirSync(project);
  const { workspaces, pipeline } = createPipeline(allowedRoot);
  const registered = workspaces.register(project);
  const snapshot = readDiff(pipeline, registered.workspaceId);
  assert.equal(snapshot.workspaceId, registered.workspaceId);
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.source, 'none');
  assert.deepEqual(snapshot.files, []);
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.omittedCount, 0);
  assert.equal(snapshot.totalAdditions, 0);
  assert.equal(snapshot.totalDeletions, 0);
});

test('unknown workspace is a command error', () => {
  const allowedRoot = makeRoot();
  const { pipeline } = createPipeline(allowedRoot);
  assert.throws(
    () => pipeline.handleCommand(diffCommand('missing-workspace')),
    WorkspaceNotFoundError,
  );
});

test('client-supplied path and git options are ignored', () => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  const outsider = makeRoot();
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'inside.txt'), 'in\n');
  fs.writeFileSync(path.join(outsider, 'secret.txt'), 'nope\n');
  const { workspaces, pipeline } = createPipeline(allowedRoot);
  const registered = workspaces.register(project);
  const snapshot = readDiff(pipeline, registered.workspaceId, {
    path: outsider,
    gitArgs: ['--git-dir', path.join(outsider, '.git')],
    options: { extra: true },
  });
  assert.equal(snapshot.workspaceId, registered.workspaceId);
  assert.equal(snapshot.source, 'none');
  assert.equal(JSON.stringify(snapshot).includes('secret.txt'), false);
});

test('git snapshots cover staged, unstaged, combined, untracked, rename, delete, binary, sensitive, limits, and special paths', async (t) => {
  if (!gitOk()) {
    t.skip('git is not available');
    return;
  }

  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'repo');
  fs.mkdirSync(project);
  initGit(project);
  fs.writeFileSync(path.join(project, 'tracked.txt'), 'base\n');
  fs.writeFileSync(path.join(project, 'will-delete.txt'), 'gone\n');
  fs.writeFileSync(path.join(project, 'will-rename.txt'), 'rename-me\n');
  fs.writeFileSync(path.join(project, 'unstaged-only.txt'), 'clean\n');
  git(project, ['add', 'tracked.txt', 'will-delete.txt', 'will-rename.txt', 'unstaged-only.txt']);
  git(project, ['commit', '-m', 'init']);

  fs.writeFileSync(path.join(project, 'tracked.txt'), 'staged\n');
  git(project, ['add', 'tracked.txt']);
  fs.writeFileSync(path.join(project, 'tracked.txt'), 'combined\n');
  fs.writeFileSync(path.join(project, 'staged-only.txt'), 'staged-only\n');
  git(project, ['add', 'staged-only.txt']);
  fs.writeFileSync(path.join(project, 'unstaged-only.txt'), 'unstaged-only\n');
  fs.writeFileSync(path.join(project, 'fresh.txt'), 'untracked-line\n');
  fs.unlinkSync(path.join(project, 'will-delete.txt'));
  git(project, ['mv', 'will-rename.txt', 'renamed.txt']);
  fs.writeFileSync(path.join(project, 'binary.bin'), Buffer.from([0x00, 0x01, 0xff, 0x00]));
  fs.writeFileSync(path.join(project, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(project, 'file with spaces.txt'), 'spaces\n');
  fs.writeFileSync(path.join(project, '-leading-dash.txt'), 'dash\n');
  fs.writeFileSync(path.join(project, '日本語.txt'), 'unicode\n');

  const { workspaces, pipeline } = createPipeline(allowedRoot);
  const registered = workspaces.register(project);
  const snapshot = readDiff(pipeline, registered.workspaceId, {
    path: path.join(allowedRoot, 'nope'),
    options: { gitArgs: ['status'] },
  });

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.source, 'git');
  const tracked = fileNamed(snapshot, 'tracked.txt');
  assert.equal(tracked?.change, 'modified');
  assert.match(tracked?.unifiedDiff ?? '', /combined/);
  assert.equal((tracked?.unifiedDiff ?? '').includes('SECRET='), false);

  const untracked = fileNamed(snapshot, 'fresh.txt');
  assert.equal(untracked?.change, 'untracked');
  assert.match(untracked?.unifiedDiff ?? '', /\+untracked-line/);
  assert.match(untracked?.unifiedDiff ?? '', /^diff --git /m);

  const stagedOnly = fileNamed(snapshot, 'staged-only.txt');
  assert.equal(stagedOnly?.change, 'added');
  assert.match(stagedOnly?.unifiedDiff ?? '', /staged-only/);

  const unstagedOnly = fileNamed(snapshot, 'unstaged-only.txt');
  assert.equal(unstagedOnly?.change, 'modified');
  assert.match(unstagedOnly?.unifiedDiff ?? '', /unstaged-only/);

  const deleted = fileNamed(snapshot, 'will-delete.txt');
  assert.equal(deleted?.change, 'deleted');
  assert.equal(deleted?.previousPath, null);
  assert.equal(deleted?.unifiedDiff === null, false);

  const renamed = fileNamed(snapshot, 'renamed.txt');
  assert.equal(renamed?.path, 'renamed.txt');
  assert.equal(renamed?.change, 'renamed');
  assert.equal(renamed?.previousPath, 'will-rename.txt');
  assert.equal(fileNamed(snapshot, 'will-rename.txt'), undefined);

  const binary = fileNamed(snapshot, 'binary.bin');
  assert.equal(binary?.binary, true);
  assert.equal(binary?.unifiedDiff, null);

  const envFile = fileNamed(snapshot, '.env');
  assert.equal(envFile?.sensitive, true);
  assert.equal(envFile?.unifiedDiff, null);
  assert.equal(JSON.stringify(snapshot).includes('SECRET=1'), false);

  assert.ok(fileNamed(snapshot, 'file with spaces.txt'));
  assert.ok(fileNamed(snapshot, '-leading-dash.txt'));
  assert.ok(fileNamed(snapshot, '日本語.txt'));
  assert.equal(snapshot.totalAdditions >= 1, true);
});

test('unborn git repositories stay available as git', (t) => {
  if (!gitOk()) {
    t.skip('git is not available');
    return;
  }
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'unborn');
  fs.mkdirSync(project);
  initGit(project);
  fs.writeFileSync(path.join(project, 'staged.txt'), 'hello\n');
  git(project, ['add', 'staged.txt']);
  fs.writeFileSync(path.join(project, 'loose.txt'), 'loose\n');
  const { workspaces, pipeline } = createPipeline(allowedRoot);
  const registered = workspaces.register(project);
  const snapshot = readDiff(pipeline, registered.workspaceId);
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.source, 'git');
  assert.equal(fileNamed(snapshot, 'staged.txt')?.change, 'added');
  assert.equal(fileNamed(snapshot, 'loose.txt')?.change, 'untracked');
});

test('output is restricted to the registered workspace when the git root is above it', (t) => {
  if (!gitOk()) {
    t.skip('git is not available');
    return;
  }
  const allowedRoot = makeRoot();
  const repo = path.join(allowedRoot, 'repo');
  const nested = path.join(repo, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  initGit(repo);
  fs.writeFileSync(path.join(repo, 'sibling.txt'), 'sib\n');
  fs.writeFileSync(path.join(nested, 'only.txt'), 'nested\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);
  fs.writeFileSync(path.join(repo, 'sibling.txt'), 'changed-sib\n');
  fs.writeFileSync(path.join(nested, 'only.txt'), 'changed-nested\n');
  const { workspaces, pipeline } = createPipeline(allowedRoot);
  const registered = workspaces.register(nested);
  const snapshot = readDiff(pipeline, registered.workspaceId);
  assert.equal(snapshot.available, true);
  const only = fileNamed(snapshot, 'only.txt');
  assert.equal(only?.path, 'only.txt');
  assert.match(only?.unifiedDiff ?? '', /changed-nested/);
  assert.equal(
    snapshot.files.some(
      (file) =>
        file.path.includes('sibling') ||
        file.path.includes('nested/') ||
        file.path === 'nested/only.txt',
    ),
    false,
  );
  assert.equal(JSON.stringify(snapshot).includes('changed-sib'), false);
  assert.equal(JSON.stringify(snapshot).includes('sibling.txt'), false);
});

test('file count and per-file byte limits omit or truncate changed files', (t) => {
  if (!gitOk()) {
    t.skip('git is not available');
    return;
  }
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'limits');
  fs.mkdirSync(project);
  initGit(project);
  fs.writeFileSync(path.join(project, 'README.md'), 'ok\n');
  git(project, ['add', 'README.md']);
  git(project, ['commit', '-m', 'init']);
  for (let index = 0; index < MAX_DIFF_FILES + 1; index += 1) {
    fs.writeFileSync(
      path.join(project, `n${String(index).padStart(2, '0')}.txt`),
      `file-${index}\n`,
    );
  }
  const huge = `${'x'.repeat(MAX_DIFF_FILE_BYTES + 64)}\n`;
  fs.writeFileSync(path.join(project, 'huge.txt'), huge);
  const { workspaces, pipeline } = createPipeline(allowedRoot);
  const registered = workspaces.register(project);
  const snapshot = readDiff(pipeline, registered.workspaceId);
  assert.equal(snapshot.files.length <= MAX_DIFF_FILES, true);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.omittedCount >= 1, true);
  const oversized = snapshot.files.find((file) => file.path === 'huge.txt');
  if (oversized?.unifiedDiff !== undefined && oversized.unifiedDiff !== null) {
    assert.equal(Buffer.byteLength(oversized.unifiedDiff, 'utf8') <= MAX_DIFF_FILE_BYTES, true);
    assert.equal(oversized.truncated, true);
  }
});

test('serialized snapshot stays at or under the payload byte cap', (t) => {
  if (!gitOk()) {
    t.skip('git is not available');
    return;
  }
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'payload');
  fs.mkdirSync(project);
  initGit(project);
  fs.writeFileSync(path.join(project, 'README.md'), 'ok\n');
  git(project, ['add', 'README.md']);
  git(project, ['commit', '-m', 'init']);
  const chunk = `${'y'.repeat(20_000)}\n`;
  for (let index = 0; index < 20; index += 1) {
    fs.writeFileSync(path.join(project, `p${index}.txt`), chunk);
  }
  const { workspaces, pipeline } = createPipeline(allowedRoot);
  const registered = workspaces.register(project);
  const snapshot = readDiff(pipeline, registered.workspaceId);
  assert.equal(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= MAX_DIFF_PAYLOAD_BYTES, true);
  assert.equal(snapshot.truncated, true);
});

test('symlink and path escape entries are omitted without leaking outside content', (t) => {
  if (!gitOk()) {
    t.skip('git is not available');
    return;
  }
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'safe');
  const outside = makeRoot();
  fs.mkdirSync(project);
  initGit(project);
  fs.writeFileSync(path.join(project, 'README.md'), 'ok\n');
  git(project, ['add', 'README.md']);
  git(project, ['commit', '-m', 'init']);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE_SECRET\n');
  const linked = tryFileLink(path.join(outside, 'secret.txt'), path.join(project, 'escape.txt'));
  fs.writeFileSync(path.join(project, 'local.txt'), 'inside\n');
  const innerLink = tryFileLink('local.txt', path.join(project, 'inner-link.txt'));
  const { workspaces, pipeline } = createPipeline(allowedRoot);
  const registered = workspaces.register(project);
  const snapshot = readDiff(pipeline, registered.workspaceId);
  assert.equal(JSON.stringify(snapshot).includes('OUTSIDE_SECRET'), false);
  if (linked) {
    assert.equal(fileNamed(snapshot, 'escape.txt'), undefined);
    assert.equal(snapshot.omittedCount >= 1, true);
  }
  if (innerLink) {
    const inner = fileNamed(snapshot, 'inner-link.txt');
    assert.ok(inner);
    assert.equal(inner.unifiedDiff, null);
    assert.equal(inner.binary, true);
    assert.equal(inner.sensitive, false);
  }
});

test('git failure after identifying a repository is an error, not a partial success', (t) => {
  if (!gitOk()) {
    t.skip('git is not available');
    return;
  }
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'broken');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(project, '.git'));
  const { workspaces, pipeline } = createPipeline(allowedRoot);
  const registered = workspaces.register(project);
  assert.throws(() => pipeline.handleCommand(diffCommand(registered.workspaceId)), GitDiffError);
});

test('daemon intercepts diff.read before the session adapter', async (t) => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'daemon-ws');
  fs.mkdirSync(project);
  const daemon = await Daemon.start({
    acp: {
      ...mockLaunch(),
      shutdownTimeoutMs: 1000,
    },
    workspaces: { allowedRoots: [allowedRoot] },
  });
  t.after(() => daemon.stop());
  const registered = daemon.workspaces.register(project);
  const events = [];
  const stop = daemon.onEvent((event) => events.push(event));
  const snapshot = await daemon.handleCommand(diffCommand(registered.workspaceId));
  stop();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.source, 'none');
  assert.equal(
    events.some((event) => event.type === 'diff.updated' && event.sessionId === null),
    true,
  );
});
