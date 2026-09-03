import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  generateP256KeyPair,
  parseTransportFrame,
  serializeRemoteFrame,
  serializeTransportFrame,
  signAuthProof,
  signPairProof,
} from '@cursor-remote/protocol';
import { WebSocket, WebSocketServer } from 'ws';

import { attachDaemonToRelay, Daemon } from '../dist/index.js';
import { RelayServer } from '../../relay/dist/index.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-acp.mjs');
const TERMINAL_EVENT_TYPES = new Set(['agent.completed', 'agent.failed', 'agent.interrupted']);

function mockLaunch() {
  return {
    command: process.execPath,
    args: [fixture],
  };
}

async function openClient(url) {
  const socket = new WebSocket(url);
  const frames = [];
  socket.on('message', (data, isBinary) => {
    if (!isBinary) {
      frames.push(parseTransportFrame(String(data)));
    }
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, frames };
}

async function closeWs(socket) {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise((resolve) => {
    socket.once('close', resolve);
    if (socket.readyState !== WebSocket.CLOSING) {
      socket.close();
    }
  });
}

function lastKind(frames, kind) {
  return [...frames].reverse().find((frame) => frame.kind === kind);
}

async function waitUntil(predicate, timeoutMs = 4000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitQuiet(ms = 40) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForResult(frames, requestId, timeoutMs = 8000) {
  await waitUntil(
    () => frames.some((frame) => frame.kind === 'result' && frame.result.requestId === requestId),
    timeoutMs,
  );
  return frames.find((frame) => frame.kind === 'result' && frame.result.requestId === requestId);
}

let commandSeq = 0;

async function rpc(socket, frames, type, payload, sessionId = null) {
  commandSeq += 1;
  const command = {
    requestId: `req-${commandSeq}-${type}`,
    sessionId,
    timestamp: new Date().toISOString(),
    type,
    payload,
  };
  socket.send(serializeRemoteFrame({ kind: 'command', command }));
  const frame = await waitForResult(frames, command.requestId);
  if (!frame.result.ok) {
    throw new Error(frame.result.error ?? 'command failed');
  }
  return frame.result.value;
}

async function pairDevice(socket, frames, qr, keys, machineId) {
  await waitUntil(() => frames.some((frame) => frame.kind === 'auth_challenge'));
  const challenge = lastKind(frames, 'auth_challenge');
  commandSeq += 1;
  const requestId = `req-${commandSeq}-pair`;
  socket.send(
    serializeTransportFrame({
      kind: 'pair',
      requestId,
      token: qr.token,
      publicKey: keys.publicKey,
      signature: signPairProof(keys.privateKey, {
        machineId,
        nonce: challenge.nonce,
        token: qr.token,
        publicKey: keys.publicKey,
      }),
    }),
  );
  const frame = await waitForResult(frames, requestId);
  if (!frame.result.ok) {
    throw new Error(frame.result.error ?? 'pair failed');
  }
  return frame.result.value.deviceId;
}

async function authDevice(socket, frames, keys, machineId, deviceId) {
  await waitUntil(() => frames.some((frame) => frame.kind === 'auth_challenge'));
  const challenge = lastKind(frames, 'auth_challenge');
  commandSeq += 1;
  const requestId = `req-${commandSeq}-auth`;
  socket.send(
    serializeTransportFrame({
      kind: 'auth_proof',
      requestId,
      deviceId,
      signature: signAuthProof(keys.privateKey, {
        machineId,
        nonce: challenge.nonce,
        deviceId,
      }),
    }),
  );
  const frame = await waitForResult(frames, requestId);
  if (!frame.result.ok) {
    throw new Error(frame.result.error ?? 'auth failed');
  }
  return frame.result.value.deviceId;
}

function eventsFrom(frames, startIndex) {
  return frames
    .slice(startIndex)
    .filter((frame) => frame.kind === 'event')
    .map((frame) => frame.event);
}

function joinedAssistantText(events) {
  return events
    .filter((event) => event.type === 'assistant.message')
    .map((event) => event.payload.text)
    .join('');
}

function assistantArrivedBeforeTerminal(events) {
  const assistant = events.findIndex((event) => event.type === 'assistant.message');
  const terminal = events.findIndex((event) => TERMINAL_EVENT_TYPES.has(event.type));
  return assistant !== -1 && (terminal === -1 || assistant < terminal);
}

test('websocket mock ACP e2e: commands, streaming, cancel, restart, continuation', async (t) => {
  const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-e2e-root-'));
  const workspacePath = path.join(allowedRoot, 'project');
  fs.mkdirSync(workspacePath);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-e2e-state-'));

  const server = await RelayServer.listen({
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: 0,
  });
  t.after(() => server.close());

  const machineId = 'pc-e2e';
  const keys = generateP256KeyPair();
  const opened = await openClient(server.clientUrl(machineId));
  const client = opened.socket;
  const frames = opened.frames;
  t.after(() => closeWs(client));

  async function startAttachedDaemon() {
    const daemon = await Daemon.start({
      acp: {
        ...mockLaunch(),
        shutdownTimeoutMs: 1000,
      },
      workspaces: { allowedRoots: [allowedRoot] },
      stateDir,
    });
    const connection = await attachDaemonToRelay(daemon, server.machineUrl(machineId));
    return { daemon, connection };
  }

  async function stopAttached({ daemon, connection }) {
    await connection.close();
    await daemon.stop();
  }

  const first = await startAttachedDaemon();
  let workspaceId;
  let remoteSessionId;
  let deviceId;
  let challengeCountBeforeStop = 0;
  try {
    const qr = first.daemon.pairing.createQrPayload({
      relayUrl: `ws://127.0.0.1:${server.port}`,
      machineId,
    });
    deviceId = await pairDevice(client, frames, qr, keys, machineId);
    assert.equal(typeof deviceId, 'string');
    assert.ok(deviceId.length > 0);

    const registered = await rpc(client, frames, 'workspace.register', { path: workspacePath });
    workspaceId = registered.workspaceId;
    const workspaces = await rpc(client, frames, 'workspace.list', {});
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].workspaceId, workspaceId);

    const created = await rpc(client, frames, 'session.create', {
      workspaceId,
      initialPrompt: '',
      title: 'e2e',
    });
    remoteSessionId = created.remoteSessionId;
    assert.equal(created.status, 'idle');
    const listed = await rpc(client, frames, 'session.list', { workspaceId });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].remoteSessionId, remoteSessionId);

    fs.mkdirSync(path.join(workspacePath, 'src'));
    fs.writeFileSync(path.join(workspacePath, 'src', 'foo.ts'), 'export const n = 1;\n');
    const fileStart = frames.length;
    const fileContent = await rpc(
      client,
      frames,
      'file.read',
      {
        path: 'src/foo.ts',
        workspaceId,
        startLine: 1,
        gitArgs: ['show'],
      },
      remoteSessionId,
    );
    assert.equal(fileContent.path, 'src/foo.ts');
    assert.equal(fileContent.content, 'export const n = 1;\n');
    assert.equal(fileContent.truncated, false);
    assert.equal(
      eventsFrom(frames, fileStart).some(
        (event) => event.type === 'file.reference' || event.type === 'file.content',
      ),
      false,
    );

    const diffStart = frames.length;
    const diffSnapshot = await rpc(
      client,
      frames,
      'diff.read',
      {
        workspaceId,
        path: '/etc/passwd',
        gitArgs: ['status', '--porcelain'],
        options: { extra: true },
      },
      null,
    );
    assert.equal(diffSnapshot.workspaceId, workspaceId);
    assert.equal(diffSnapshot.available, false);
    assert.equal(diffSnapshot.source, 'none');
    assert.deepEqual(diffSnapshot.files, []);
    assert.equal(diffSnapshot.omittedCount, 0);
    const diffEvents = eventsFrom(frames, diffStart).filter(
      (event) => event.type === 'diff.updated',
    );
    assert.equal(diffEvents.length, 1);
    assert.equal(diffEvents[0].sessionId, null);
    assert.deepEqual(diffEvents[0].payload, diffSnapshot);

    const sendStart = frames.length;
    await rpc(client, frames, 'session.send', { text: 'hello-stream' }, remoteSessionId);
    const streamed = eventsFrom(frames, sendStart);
    assert.equal(assistantArrivedBeforeTerminal(streamed), true);
    assert.equal(joinedAssistantText(streamed), 'echo:hello-stream');
    assert.equal(
      streamed.some((event) => event.type === 'agent.completed'),
      true,
    );

    const cancelStart = frames.length;
    const sending = rpc(client, frames, 'session.send', { text: 'DELAY' }, remoteSessionId);
    await waitUntil(() =>
      eventsFrom(frames, cancelStart).some(
        (event) => event.type === 'assistant.status' && event.payload.status === 'thinking',
      ),
    );
    const cancelValue = await rpc(client, frames, 'session.cancel', {}, remoteSessionId);
    assert.equal(cancelValue, null);
    assert.equal(await sending, null);
    assert.equal(
      eventsFrom(frames, cancelStart).some((event) => event.type === 'agent.interrupted'),
      true,
    );
    challengeCountBeforeStop = frames.filter((frame) => frame.kind === 'auth_challenge').length;
  } finally {
    await stopAttached(first);
  }

  await waitUntil(
    () =>
      frames.filter((frame) => frame.kind === 'auth_challenge').length > challengeCountBeforeStop,
  );

  const second = await startAttachedDaemon();
  try {
    const authenticated = await authDevice(client, frames, keys, machineId, deviceId);
    assert.equal(authenticated, deviceId);

    const listed = await rpc(client, frames, 'session.list', { workspaceId });
    assert.equal(
      listed.some((session) => session.remoteSessionId === remoteSessionId),
      true,
    );
    const loaded = await rpc(client, frames, 'session.load', { remoteSessionId });
    assert.equal(loaded.remoteSessionId, remoteSessionId);
    assert.equal(loaded.status, 'idle');

    const continueStart = frames.length;
    await rpc(client, frames, 'session.send', { text: 'follow-up' }, remoteSessionId);
    const continued = eventsFrom(frames, continueStart);
    assert.equal(assistantArrivedBeforeTerminal(continued), true);
    assert.match(joinedAssistantText(continued), /echo:follow-up/);
  } finally {
    await stopAttached(second);
  }
});

test('websocket relays permission requested and approve command correlation', async (t) => {
  const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-perm-root-'));
  const workspacePath = path.join(allowedRoot, 'project');
  fs.mkdirSync(workspacePath);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-perm-state-'));

  const server = await RelayServer.listen({
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: 0,
  });
  t.after(() => server.close());

  const machineId = 'pc-perm';
  const keys = generateP256KeyPair();
  const opened = await openClient(server.clientUrl(machineId));
  const client = opened.socket;
  const frames = opened.frames;
  t.after(() => closeWs(client));

  const daemon = await Daemon.start({
    acp: {
      ...mockLaunch(),
      shutdownTimeoutMs: 1000,
    },
    workspaces: { allowedRoots: [allowedRoot] },
    stateDir,
  });
  t.after(() => daemon.stop());
  const connection = await attachDaemonToRelay(daemon, server.machineUrl(machineId));
  t.after(() => connection.close());

  const qr = daemon.pairing.createQrPayload({
    relayUrl: `ws://127.0.0.1:${server.port}`,
    machineId,
  });
  await pairDevice(client, frames, qr, keys, machineId);
  const registered = await rpc(client, frames, 'workspace.register', { path: workspacePath });
  const created = await rpc(client, frames, 'session.create', {
    workspaceId: registered.workspaceId,
    initialPrompt: '',
    title: 'perm',
  });
  const sendStart = frames.length;
  const sending = rpc(
    client,
    frames,
    'session.send',
    { text: 'ASK_PERMISSION' },
    created.remoteSessionId,
  );
  await waitUntil(() =>
    eventsFrom(frames, sendStart).some((event) => event.type === 'permission.requested'),
  );
  const requested = eventsFrom(frames, sendStart).find(
    (event) => event.type === 'permission.requested',
  );
  assert.equal(requested.sessionId, created.remoteSessionId);
  assert.equal(requested.payload.permissionId.length > 0, true);
  assert.equal(requested.payload.risk, 'high');
  assert.equal(JSON.stringify(requested.payload).includes('allow-always'), false);
  await rpc(
    client,
    frames,
    'permission.approve',
    { permissionId: requested.payload.permissionId },
    created.remoteSessionId,
  );
  assert.equal(await sending, null);
  const streamed = eventsFrom(frames, sendStart);
  assert.equal(
    streamed.some(
      (event) =>
        event.type === 'permission.resolved' &&
        event.payload.permissionId === requested.payload.permissionId &&
        event.payload.decision === 'approved',
    ),
    true,
  );
  assert.match(joinedAssistantText(streamed), /echo:ASK_PERMISSION:allow-once/);
  assert.equal(
    streamed.some((event) => event.type === 'agent.completed'),
    true,
  );
});

test('sync.catch_up replays after auth and does not mix into other live streams', async (t) => {
  const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sync-root-'));
  const workspacePath = path.join(allowedRoot, 'project');
  fs.mkdirSync(workspacePath);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sync-state-'));
  const server = await RelayServer.listen({
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: 0,
  });
  t.after(() => server.close());

  const machineId = 'pc-sync';
  const keys = generateP256KeyPair();
  const daemon = await Daemon.start({
    acp: { ...mockLaunch(), shutdownTimeoutMs: 1000 },
    workspaces: { allowedRoots: [allowedRoot] },
    stateDir,
  });
  t.after(() => daemon.stop());
  const connection = await attachDaemonToRelay(daemon, server.machineUrl(machineId));
  t.after(() => connection.close());

  const first = await openClient(server.clientUrl(machineId));
  t.after(() => closeWs(first.socket));
  const qr = daemon.pairing.createQrPayload({
    relayUrl: `ws://127.0.0.1:${server.port}`,
    machineId,
  });
  const deviceId = await pairDevice(first.socket, first.frames, qr, keys, machineId);
  const registered = await rpc(first.socket, first.frames, 'workspace.register', {
    path: workspacePath,
  });
  const created = await rpc(first.socket, first.frames, 'session.create', {
    workspaceId: registered.workspaceId,
    initialPrompt: '',
    title: 'sync',
  });
  await rpc(
    first.socket,
    first.frames,
    'session.send',
    { text: 'hello-stream' },
    created.remoteSessionId,
  );
  const liveEvents = eventsFrom(first.frames, 0);
  const head = liveEvents.at(-1).eventId;

  const nullCatch = await rpc(
    first.socket,
    first.frames,
    'sync.catch_up',
    { lastEventId: null },
    created.remoteSessionId,
  );
  assert.equal(nullCatch.status, 'replayed');
  assert.deepEqual(nullCatch.events, []);
  assert.equal(nullCatch.headEventId, head);

  const firstId = liveEvents[0].eventId;
  const replayed = await rpc(
    first.socket,
    first.frames,
    'sync.catch_up',
    { lastEventId: firstId },
    created.remoteSessionId,
  );
  assert.equal(replayed.status, 'replayed');
  assert.ok(replayed.events.length > 0);
  assert.equal(replayed.events[0].eventId, liveEvents[1].eventId);

  const second = await openClient(server.clientUrl(machineId));
  t.after(() => closeWs(second.socket));
  await authDevice(second.socket, second.frames, keys, machineId, deviceId);
  commandSeq += 1;
  const unicastId = `req-${commandSeq}-sync.catch_up`;
  first.socket.send(
    serializeRemoteFrame({
      kind: 'command',
      command: {
        requestId: unicastId,
        sessionId: created.remoteSessionId,
        timestamp: new Date().toISOString(),
        type: 'sync.catch_up',
        payload: { lastEventId: firstId },
      },
    }),
  );
  const unicastFrame = await waitForResult(first.frames, unicastId);
  assert.equal(unicastFrame.result.ok, true);
  assert.equal(unicastFrame.result.value.status, 'replayed');
  await waitQuiet();
  assert.equal(
    second.frames.some((frame) => frame.kind === 'result' && frame.result.requestId === unicastId),
    false,
  );
  const replayedIds = new Set(unicastFrame.result.value.events.map((event) => event.eventId));
  assert.equal(
    second.frames.some((frame) => frame.kind === 'event' && replayedIds.has(frame.event.eventId)),
    false,
  );

  const gap = await rpc(first.socket, first.frames, 'sync.catch_up', { lastEventId: 'missing' });
  assert.equal(gap.status, 'gap');
  assert.deepEqual(gap.events, []);
});

test('daemon reconnects after unexpected relay drop, keeps EventLog, and close() stops retries', async (t) => {
  const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-re-root-'));
  const workspacePath = path.join(allowedRoot, 'project');
  fs.mkdirSync(workspacePath);
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const sockets = [];
  wss.on('connection', (socket) => {
    sockets.push(socket);
  });
  await new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        wss.close(() => httpServer.close(resolve));
      }),
  );
  const address = httpServer.address();
  const url = `ws://127.0.0.1:${address.port}/machine?machineId=pc-re`;
  const daemon = await Daemon.start({
    acp: { ...mockLaunch(), shutdownTimeoutMs: 1000 },
    workspaces: { allowedRoots: [allowedRoot] },
  });
  t.after(() => daemon.stop());

  const connection = await attachDaemonToRelay(daemon, url);
  assert.equal(sockets.length, 1);
  const registered = await daemon.handleCommand(
    parseTransportFrame(
      serializeRemoteFrame({
        kind: 'command',
        command: {
          requestId: 'req-reg',
          sessionId: null,
          timestamp: new Date().toISOString(),
          type: 'workspace.register',
          payload: { path: workspacePath },
        },
      }),
    ).command,
  );
  assert.equal(typeof registered.workspaceId, 'string');
  const beforeDrop = await daemon.handleCommand(
    parseTransportFrame(
      serializeRemoteFrame({
        kind: 'command',
        command: {
          requestId: 'req-before',
          sessionId: null,
          timestamp: new Date().toISOString(),
          type: 'sync.catch_up',
          payload: { lastEventId: null },
        },
      }),
    ).command,
  );
  sockets[0].terminate();
  await waitUntil(() => sockets[0].readyState === WebSocket.CLOSED);
  await daemon.workspaces.register(workspacePath);
  const duringDrop = await daemon.handleCommand(
    parseTransportFrame(
      serializeRemoteFrame({
        kind: 'command',
        command: {
          requestId: 'req-during',
          sessionId: null,
          timestamp: new Date().toISOString(),
          type: 'sync.catch_up',
          payload: { lastEventId: beforeDrop.headEventId },
        },
      }),
    ).command,
  );
  assert.equal(duringDrop.status, 'replayed');
  assert.ok(duringDrop.events.length > 0);
  await waitUntil(() => sockets.length >= 2, 4000);
  await connection.close();
  const afterClose = sockets.length;
  await waitQuiet(800);
  assert.equal(sockets.length, afterClose);
});

test('daemon does not reconnect after Machine replaced close', async (t) => {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const sockets = [];
  wss.on('connection', (socket) => {
    sockets.push(socket);
  });
  await new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        wss.close(() => httpServer.close(resolve));
      }),
  );
  const address = httpServer.address();
  const url = `ws://127.0.0.1:${address.port}/machine?machineId=pc-replaced`;
  const daemon = await Daemon.start({
    acp: { ...mockLaunch(), shutdownTimeoutMs: 1000 },
  });
  t.after(() => daemon.stop());

  const connection = await attachDaemonToRelay(daemon, url);
  assert.equal(sockets.length, 1);
  sockets[0].close(1000, 'Machine replaced');
  await waitUntil(() => sockets[0].readyState === WebSocket.CLOSED);
  await waitQuiet(800);
  assert.equal(sockets.length, 1);
  await connection.close();
  const afterClose = sockets.length;
  await waitQuiet(800);
  assert.equal(sockets.length, afterClose);
});

test('first relay connect failure rejects and does not retry', async (t) => {
  const server = await RelayServer.listen({
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: 0,
  });
  const url = server.machineUrl('pc-fail');
  await server.close();
  const daemon = await Daemon.start({
    acp: { ...mockLaunch(), shutdownTimeoutMs: 1000 },
  });
  t.after(() => daemon.stop());
  await assert.rejects(() => attachDaemonToRelay(daemon, url));
});
