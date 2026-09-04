import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  deviceIdFromPublicKey,
  generateP256KeyPair,
  parseRemoteCommand,
  serializeCommand,
} from '@cursor-remote/protocol';

import {
  Daemon,
  METADATA_FILE_NAME,
  MetadataStore,
  MetadataStoreError,
  WorkspaceNotFoundError,
  WorkspacePathError,
} from '../dist/index.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-acp.mjs');
const spawnMarker = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'spawn-marker.mjs',
);

function mockLaunch() {
  return {
    command: process.execPath,
    args: [fixture],
  };
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-store-'));
}

function tryDirLink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, 'dir');
    return true;
  } catch {
    try {
      fs.symlinkSync(target, linkPath, 'junction');
      return true;
    } catch {
      return false;
    }
  }
}

function readMetadata(stateDir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, METADATA_FILE_NAME), 'utf8'));
}

async function startDaemon(stateDir, allowedRoots, acpExtra = {}) {
  return Daemon.start({
    acp: {
      ...mockLaunch(),
      shutdownTimeoutMs: 1000,
      ...acpExtra,
    },
    workspaces: { allowedRoots },
    stateDir,
  });
}

test('daemon restart restores session list, load, and a follow-up prompt', async () => {
  const stateDir = makeRoot();
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  fs.mkdirSync(project);

  const first = await startDaemon(stateDir, [allowedRoot]);
  let remoteSessionId;
  let workspaceId;
  let cursorSessionId;
  try {
    const registered = first.workspaces.register(project);
    workspaceId = registered.workspaceId;
    const created = await first.sessions.create({
      workspaceId,
      initialPrompt: 'hello',
      title: 'probe',
    });
    remoteSessionId = created.remoteSessionId;
    cursorSessionId = created.cursorSessionId;
    assert.equal(created.status, 'completed');
    assert.equal(readMetadata(stateDir).sessions[0].selectedModelId, 'mock-model');
  } finally {
    await first.stop();
  }

  const second = await startDaemon(stateDir, [allowedRoot]);
  try {
    const workspaces = second.workspaces.list();
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].workspaceId, workspaceId);

    const listed = second.sessions.list(workspaceId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].remoteSessionId, remoteSessionId);
    assert.equal(listed[0].cursorSessionId, cursorSessionId);
    assert.equal(listed[0].title, 'probe');
    assert.equal(listed[0].workspaceId, workspaceId);
    assert.equal(readMetadata(stateDir).sessions[0].selectedModelId, 'mock-model');

    const loaded = await second.sessions.load(remoteSessionId);
    assert.equal(loaded.remoteSessionId, remoteSessionId);
    assert.equal(loaded.status, 'idle');
    assert.equal(readMetadata(stateDir).sessions[0].selectedModelId, 'mock-model');

    await second.sessions.send(remoteSessionId, 'follow-up');
    const afterSend = second.sessions.list(workspaceId);
    assert.equal(afterSend[0].status, 'completed');
  } finally {
    await second.stop();
  }
});

test('restart catch-up is a gap and EventLog is not persisted', async () => {
  const stateDir = makeRoot();
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  fs.mkdirSync(project);

  const first = await startDaemon(stateDir, [allowedRoot]);
  let remoteSessionId;
  let workspaceId;
  let headEventId;
  try {
    const registered = first.workspaces.register(project);
    workspaceId = registered.workspaceId;
    const created = await first.sessions.create({
      workspaceId,
      initialPrompt: 'hello',
      title: 'probe',
    });
    remoteSessionId = created.remoteSessionId;
    const catchUp = await first.handleCommand(
      parseRemoteCommand(
        serializeCommand({
          requestId: 'req-catch-up-1',
          sessionId: remoteSessionId,
          timestamp: new Date().toISOString(),
          type: 'sync.catch_up',
          payload: { lastEventId: null },
        }),
      ),
    );
    headEventId = catchUp.headEventId;
    assert.equal(typeof headEventId, 'string');
  } finally {
    await first.stop();
  }

  const persisted = readMetadata(stateDir);
  assert.equal('events' in persisted, false);
  assert.equal(JSON.stringify(persisted).includes('echo:hello'), false);

  const second = await startDaemon(stateDir, [allowedRoot]);
  try {
    const gap = await second.handleCommand(
      parseRemoteCommand(
        serializeCommand({
          requestId: 'req-catch-up-2',
          sessionId: remoteSessionId,
          timestamp: new Date().toISOString(),
          type: 'sync.catch_up',
          payload: { lastEventId: headEventId },
        }),
      ),
    );
    assert.equal(gap.status, 'gap');
    assert.deepEqual(gap.events, []);

    const listed = await second.sessions.handleCommand(
      parseRemoteCommand(
        serializeCommand({
          requestId: 'req-model-list',
          sessionId: remoteSessionId,
          timestamp: new Date().toISOString(),
          type: 'model.list',
          payload: {},
        }),
      ),
    );
    assert.ok(listed.models.some((model) => model.id === 'mock-model'));

    await second.sessions.send(remoteSessionId, 'follow-up');
    assert.equal(second.sessions.list(workspaceId)[0].status, 'completed');
    assert.equal(JSON.stringify(readMetadata(stateDir)).includes('echo:follow-up'), false);
  } finally {
    await second.stop();
  }
});

test('session.list filters by workspaceId', async () => {
  const stateDir = makeRoot();
  const allowedRoot = makeRoot();
  const firstProject = path.join(allowedRoot, 'one');
  const secondProject = path.join(allowedRoot, 'two');
  fs.mkdirSync(firstProject);
  fs.mkdirSync(secondProject);

  const daemon = await startDaemon(stateDir, [allowedRoot]);
  try {
    const firstWorkspace = daemon.workspaces.register(firstProject);
    const secondWorkspace = daemon.workspaces.register(secondProject);
    const firstSession = await daemon.sessions.create({
      workspaceId: firstWorkspace.workspaceId,
      initialPrompt: '',
      title: 'one',
    });
    await daemon.sessions.create({
      workspaceId: secondWorkspace.workspaceId,
      initialPrompt: '',
      title: 'two',
    });

    const listed = daemon.sessions.list(firstWorkspace.workspaceId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].remoteSessionId, firstSession.remoteSessionId);

    const viaCommand = await daemon.handleCommand(
      parseRemoteCommand(
        serializeCommand({
          requestId: 'req-list',
          sessionId: null,
          timestamp: new Date().toISOString(),
          type: 'session.list',
          payload: { workspaceId: firstWorkspace.workspaceId },
        }),
      ),
    );
    assert.ok(Array.isArray(viaCommand));
    assert.equal(viaCommand.length, 1);
    assert.equal(viaCommand[0].remoteSessionId, firstSession.remoteSessionId);

    assert.throws(() => daemon.sessions.list('missing'), WorkspaceNotFoundError);
  } finally {
    await daemon.stop();
  }
});

test('running sessions are restored as disconnected', async () => {
  const stateDir = makeRoot();
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  fs.mkdirSync(project);
  const workspaceId = 'ws-running';
  fs.writeFileSync(
    path.join(stateDir, METADATA_FILE_NAME),
    JSON.stringify({
      version: 1,
      workspaces: [
        {
          workspaceId,
          path: fs.realpathSync(project),
          name: 'app',
          lastUsedAt: null,
        },
      ],
      sessions: [
        {
          remoteSessionId: 'remote-running',
          cursorSessionId: 'cursor-running',
          workspaceId,
          title: 'live',
          status: 'running',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          lastEventId: 'evt-1',
          selectedModelId: null,
        },
        {
          remoteSessionId: 'remote-approval',
          cursorSessionId: 'cursor-approval',
          workspaceId,
          title: 'approval',
          status: 'waiting_approval',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          lastEventId: 'evt-2',
          selectedModelId: null,
        },
        {
          remoteSessionId: 'remote-user',
          cursorSessionId: 'cursor-user',
          workspaceId,
          title: 'user',
          status: 'waiting_user',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          lastEventId: 'evt-3',
          selectedModelId: null,
        },
      ],
    }),
  );

  const daemon = await startDaemon(stateDir, [allowedRoot]);
  try {
    const written = readMetadata(stateDir);
    assert.equal('events' in written, false);
    assert.equal(
      written.sessions.every((session) => session.status === 'disconnected'),
      true,
    );
    assert.deepEqual(written.sessions.map((session) => session.remoteSessionId).sort(), [
      'remote-approval',
      'remote-running',
      'remote-user',
    ]);
    const listed = daemon.sessions.list(workspaceId);
    assert.equal(listed.length, 3);
    assert.equal(
      listed.every((session) => session.status === 'disconnected'),
      true,
    );
  } finally {
    await daemon.stop();
  }
});

test('workspace replaced with an outside symlink is not restored', async (t) => {
  const stateDir = makeRoot();
  const parent = makeRoot();
  const allowedRoot = path.join(parent, 'allowed');
  const outside = path.join(parent, 'outside');
  const project = path.join(allowedRoot, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(outside);

  const first = await startDaemon(stateDir, [allowedRoot]);
  let workspaceId;
  try {
    const registered = first.workspaces.register(project);
    workspaceId = registered.workspaceId;
    await first.sessions.create({
      workspaceId,
      initialPrompt: '',
      title: 'escape',
    });
  } finally {
    await first.stop();
  }

  fs.renameSync(project, path.join(allowedRoot, 'project-old'));
  if (!tryDirLink(outside, project)) {
    t.skip('directory symlink/junction is not available');
    return;
  }

  const second = await startDaemon(stateDir, [allowedRoot]);
  try {
    assert.equal(second.workspaces.list().length, 0);
    assert.throws(() => second.sessions.list(workspaceId), WorkspaceNotFoundError);
  } finally {
    await second.stop();
  }
});

test('re-registering a repaired workspace reuses the stored id instead of duplicating', async (t) => {
  const stateDir = makeRoot();
  const parent = makeRoot();
  const allowedRoot = path.join(parent, 'allowed');
  const outside = path.join(parent, 'outside');
  const project = path.join(allowedRoot, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(outside);

  const first = await startDaemon(stateDir, [allowedRoot]);
  let workspaceId;
  try {
    workspaceId = first.workspaces.register(project).workspaceId;
  } finally {
    await first.stop();
  }

  const projectOld = path.join(allowedRoot, 'project-old');
  fs.renameSync(project, projectOld);
  if (!tryDirLink(outside, project)) {
    t.skip('directory symlink/junction is not available');
    return;
  }

  const second = await startDaemon(stateDir, [allowedRoot]);
  try {
    assert.equal(second.workspaces.list().length, 0);
    fs.unlinkSync(project);
    fs.renameSync(projectOld, project);
    const registered = second.workspaces.register(project);
    assert.equal(registered.workspaceId, workspaceId);
    assert.equal(second.workspaces.list().length, 1);
  } finally {
    await second.stop();
  }

  const third = await startDaemon(stateDir, [allowedRoot]);
  try {
    const listed = third.workspaces.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].workspaceId, workspaceId);
    assert.equal(readMetadata(stateDir).workspaces.length, 1);
  } finally {
    await third.stop();
  }
});

test('invalid metadata does not spawn an ACP child', async () => {
  const stateDir = makeRoot();
  const allowedRoot = makeRoot();
  const markerPath = path.join(stateDir, 'spawned');
  fs.writeFileSync(path.join(stateDir, METADATA_FILE_NAME), '{not-json');
  await assert.rejects(
    () =>
      Daemon.start({
        acp: {
          command: process.execPath,
          args: [spawnMarker, markerPath, fixture],
          shutdownTimeoutMs: 1000,
        },
        workspaces: { allowedRoots: [allowedRoot] },
        stateDir,
      }),
    MetadataStoreError,
  );
  assert.equal(fs.existsSync(markerPath), false);
});

test('invalid allowedRoot does not spawn an ACP child', async () => {
  const stateDir = makeRoot();
  const allowedRoot = makeRoot();
  const filePath = path.join(allowedRoot, 'notes.txt');
  fs.writeFileSync(filePath, 'x');
  const markerPath = path.join(stateDir, 'spawned');
  await assert.rejects(
    () =>
      Daemon.start({
        acp: {
          command: process.execPath,
          args: [spawnMarker, markerPath, fixture],
          shutdownTimeoutMs: 1000,
        },
        workspaces: { allowedRoots: [filePath] },
      }),
    WorkspacePathError,
  );
  assert.equal(fs.existsSync(markerPath), false);
});

test('v1 metadata without devices remains readable and can persist public devices', () => {
  const stateDir = makeRoot();
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  fs.mkdirSync(project);
  const filePath = path.join(stateDir, METADATA_FILE_NAME);
  const workspaceId = 'ws-legacy';
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      workspaces: [
        {
          workspaceId,
          path: fs.realpathSync(project),
          name: 'app',
          lastUsedAt: null,
        },
      ],
      sessions: [],
    }),
  );

  const store = new MetadataStore(filePath);
  assert.equal(store.getWorkspaces().length, 1);
  assert.equal(store.getWorkspaces()[0].workspaceId, workspaceId);
  assert.deepEqual(store.getDevices(), []);

  const keys = generateP256KeyPair();
  const deviceId = deviceIdFromPublicKey(keys.publicKey);
  store.writeDevices([
    {
      deviceId,
      publicKey: keys.publicKey,
      createdAt: '2026-08-17T00:00:00.000Z',
    },
  ]);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.workspaces[0].workspaceId, workspaceId);
  assert.equal(raw.devices.length, 1);
  assert.equal(raw.devices[0].deviceId, deviceId);
  assert.equal('d' in raw.devices[0].publicKey, false);
  assert.equal(JSON.stringify(raw).includes(keys.privateKey.d), false);

  const reread = new MetadataStore(filePath);
  assert.equal(reread.getWorkspaces()[0].workspaceId, workspaceId);
  assert.equal(reread.getDevices()[0].deviceId, deviceId);
  assert.deepEqual(reread.getDevices()[0].publicKey, keys.publicKey);

  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      workspaces: raw.workspaces,
      sessions: raw.sessions,
      devices: [
        {
          deviceId: 'not-the-canonical-device-id',
          publicKey: keys.publicKey,
          createdAt: '2026-08-17T00:00:00.000Z',
        },
      ],
    }),
  );
  const dropped = new MetadataStore(filePath);
  assert.equal(dropped.getWorkspaces()[0].workspaceId, workspaceId);
  assert.deepEqual(dropped.getDevices(), []);
});
