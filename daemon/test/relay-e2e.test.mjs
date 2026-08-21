import assert from 'node:assert/strict';
import fs from 'node:fs';
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
import { WebSocket } from 'ws';

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
