import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseTransportFrame,
  remoteCommandSuccess,
  serializeRemoteFrame,
  serializeTransportFrame,
} from '@cursor-remote/protocol';
import { WebSocket } from 'ws';

import { RelayServer } from '../dist/index.js';

async function listen(extra = {}) {
  return RelayServer.listen({
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: 0,
    ...extra,
  });
}

async function openWs(url, options) {
  const socket = options === undefined ? new WebSocket(url) : new WebSocket(url, options);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function openCollected(url, options) {
  const socket = options === undefined ? new WebSocket(url) : new WebSocket(url, options);
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

function machineCommands(frames) {
  return frames.filter((frame) => frame.kind === 'command').map((frame) => frame.command);
}

function fakePublicKey() {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: Buffer.alloc(32, 1).toString('base64url'),
    y: Buffer.alloc(32, 2).toString('base64url'),
  };
}

function fakeSignature() {
  return Buffer.alloc(32, 9).toString('base64url');
}

function fakeToken() {
  return Buffer.alloc(32, 3).toString('base64url');
}

function makeCommand(type, payload, requestId) {
  return {
    requestId: requestId ?? `req-${type}-${Math.random().toString(16).slice(2)}`,
    sessionId: null,
    timestamp: new Date().toISOString(),
    type,
    payload,
  };
}

function sendCommand(socket, command) {
  socket.send(serializeRemoteFrame({ kind: 'command', command }));
}

function sendResult(socket, result) {
  socket.send(serializeRemoteFrame({ kind: 'result', result }));
}

function sendEvent(socket, event) {
  socket.send(serializeRemoteFrame({ kind: 'event', event }));
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForResult(frames, requestId, timeoutMs = 2000) {
  await waitUntil(
    () => frames.some((frame) => frame.kind === 'result' && frame.result.requestId === requestId),
    timeoutMs,
  );
  return frames.find((frame) => frame.kind === 'result' && frame.result.requestId === requestId);
}

async function waitQuiet(ms = 40) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function completeVerification(client, clientFrames, machine, machineFrames, frame) {
  await waitUntil(() => clientFrames.some((item) => item.kind === 'auth_challenge'));
  const challenge = lastKind(clientFrames, 'auth_challenge');
  const before = machineFrames.filter((item) => item.kind === 'pairing_verify').length;
  client.send(serializeTransportFrame(frame));
  await waitUntil(
    () => machineFrames.filter((item) => item.kind === 'pairing_verify').length > before,
  );
  const verify = lastKind(machineFrames, 'pairing_verify');
  assert.equal(typeof verify.machineId, 'string');
  assert.ok(verify.machineId.length > 0);
  assert.equal(verify.nonce, challenge.nonce);
  return verify;
}

async function authenticateClient(
  client,
  clientFrames,
  machine,
  machineFrames,
  deviceId = 'dev-1',
) {
  const requestId = `auth-${Math.random().toString(16).slice(2)}`;
  const verify = await completeVerification(client, clientFrames, machine, machineFrames, {
    kind: 'auth_proof',
    requestId,
    deviceId,
    signature: fakeSignature(),
  });
  assert.equal(verify.operation, 'auth');
  assert.equal(verify.deviceId, deviceId);
  machine.send(
    serializeTransportFrame({
      kind: 'pairing_result',
      verificationId: verify.verificationId,
      ok: true,
      deviceId,
      error: null,
    }),
  );
  const result = await waitForResult(clientFrames, requestId);
  assert.equal(result.result.ok, true);
  return result;
}

async function pairClient(client, clientFrames, machine, machineFrames, deviceId = 'dev-pair') {
  const requestId = `pair-${Math.random().toString(16).slice(2)}`;
  const verify = await completeVerification(client, clientFrames, machine, machineFrames, {
    kind: 'pair',
    requestId,
    token: fakeToken(),
    publicKey: fakePublicKey(),
    signature: fakeSignature(),
  });
  assert.equal(verify.operation, 'pair');
  machine.send(
    serializeTransportFrame({
      kind: 'pairing_result',
      verificationId: verify.verificationId,
      ok: true,
      deviceId,
      error: null,
    }),
  );
  const result = await waitForResult(clientFrames, requestId);
  assert.equal(result.result.ok, true);
  return { result, verify };
}

test('routes results to the originating client and broadcasts events per machine', async (t) => {
  const server = await listen();
  t.after(() => server.close());
  const machine = await openCollected(server.machineUrl('m1'));
  const otherMachine = await openCollected(server.machineUrl('m2'));
  const clientA = await openCollected(server.clientUrl('m1'));
  const clientB = await openCollected(server.clientUrl('m1'));
  const otherClient = await openCollected(server.clientUrl('m2'));
  t.after(() =>
    Promise.all(
      [machine, otherMachine, clientA, clientB, otherClient].map((item) => closeWs(item.socket)),
    ),
  );

  await authenticateClient(clientA.socket, clientA.frames, machine.socket, machine.frames, 'dev-a');
  await authenticateClient(clientB.socket, clientB.frames, machine.socket, machine.frames, 'dev-b');
  await authenticateClient(
    otherClient.socket,
    otherClient.frames,
    otherMachine.socket,
    otherMachine.frames,
    'dev-other',
  );

  const command = makeCommand('workspace.list', {});
  sendCommand(clientA.socket, command);
  await waitUntil(() => machineCommands(machine.frames).length === 1);
  assert.equal(machineCommands(machine.frames)[0].requestId, command.requestId);

  sendResult(machine.socket, remoteCommandSuccess(command.requestId, []));
  const result = await waitForResult(clientA.frames, command.requestId);
  assert.equal(result.result.ok, true);
  assert.deepEqual(result.result.value, []);
  await waitQuiet();
  assert.equal(
    clientB.frames.some(
      (frame) => frame.kind === 'result' && frame.result.requestId === command.requestId,
    ),
    false,
  );
  assert.equal(
    otherClient.frames.some(
      (frame) => frame.kind === 'result' && frame.result.requestId === command.requestId,
    ),
    false,
  );

  const event = {
    eventId: 'evt-route',
    sessionId: 'remote_sess',
    timestamp: new Date().toISOString(),
    type: 'assistant.message',
    payload: { text: 'hi', delta: true },
  };
  sendEvent(machine.socket, event);
  await waitUntil(
    () =>
      clientA.frames.some((frame) => frame.kind === 'event') &&
      clientB.frames.some((frame) => frame.kind === 'event'),
  );
  assert.equal(clientA.frames.find((frame) => frame.kind === 'event').event.eventId, 'evt-route');
  assert.equal(clientB.frames.find((frame) => frame.kind === 'event').event.eventId, 'evt-route');
  await waitQuiet();
  assert.equal(
    otherClient.frames.some((frame) => frame.kind === 'event'),
    false,
  );
  otherMachine.socket.send(Buffer.from('ignored'));
});

test('rejects duplicate request ids and ignores unknown result correlations', async (t) => {
  const server = await listen();
  t.after(() => server.close());
  const machine = await openCollected(server.machineUrl('m1'));
  const clientA = await openCollected(server.clientUrl('m1'));
  const clientB = await openCollected(server.clientUrl('m1'));
  t.after(() => Promise.all([machine, clientA, clientB].map((item) => closeWs(item.socket))));

  await authenticateClient(clientA.socket, clientA.frames, machine.socket, machine.frames, 'dev-a');
  await authenticateClient(clientB.socket, clientB.frames, machine.socket, machine.frames, 'dev-b');

  const command = makeCommand('workspace.list', {}, 'dup-1');
  sendCommand(clientA.socket, command);
  await waitUntil(() => machineCommands(machine.frames).length === 1);
  sendCommand(clientB.socket, command);
  const duplicate = await waitForResult(clientB.frames, 'dup-1');
  assert.equal(duplicate.result.ok, false);
  assert.match(duplicate.result.error, /Duplicate request id/);
  assert.equal(machineCommands(machine.frames).length, 1);

  sendResult(machine.socket, remoteCommandSuccess('dup-1', null));
  const original = await waitForResult(clientA.frames, 'dup-1');
  assert.equal(original.result.ok, true);
  assert.equal(
    clientB.frames.filter((frame) => frame.kind === 'result' && frame.result.requestId === 'dup-1')
      .length,
    1,
  );

  sendResult(machine.socket, remoteCommandSuccess('never-seen', { leaked: true }));
  await waitQuiet();
  assert.equal(
    clientA.frames.some(
      (frame) => frame.kind === 'result' && frame.result.requestId === 'never-seen',
    ),
    false,
  );
  assert.equal(
    clientB.frames.some(
      (frame) => frame.kind === 'result' && frame.result.requestId === 'never-seen',
    ),
    false,
  );
});

test('ignores binary frames and still routes a later command', async (t) => {
  const server = await listen();
  t.after(() => server.close());
  const machine = await openCollected(server.machineUrl('m1'));
  const client = await openCollected(server.clientUrl('m1'));
  t.after(() => Promise.all([machine, client].map((item) => closeWs(item.socket))));

  await authenticateClient(client.socket, client.frames, machine.socket, machine.frames);
  client.socket.send(Buffer.from('{"kind":"command"}'), { binary: true });
  machine.socket.send(Buffer.from('{"kind":"event"}'), { binary: true });
  await waitQuiet();

  const command = makeCommand('workspace.list', {});
  sendCommand(client.socket, command);
  await waitUntil(() => machineCommands(machine.frames).length === 1);
  sendResult(machine.socket, remoteCommandSuccess(command.requestId, []));
  const result = await waitForResult(client.frames, command.requestId);
  assert.equal(result.result.ok, true);
});

test('heartbeat terminates stale sockets without dropping a healthy machine', async (t) => {
  const server = await listen({ heartbeatIntervalMs: 40, staleTimeoutMs: 120 });
  t.after(() => server.close());
  const machine = await openWs(server.machineUrl('m1'));
  const stale = await openWs(server.clientUrl('m1'), { autoPong: false });
  t.after(() => Promise.all([machine, stale].map(closeWs)));

  await waitUntil(() => stale.readyState === WebSocket.CLOSED);
  assert.equal(machine.readyState, WebSocket.OPEN);
});

test('unpaired commands never reach the machine and unpaired clients never receive events', async (t) => {
  const server = await listen();
  t.after(() => server.close());
  const machine = await openCollected(server.machineUrl('m1'));
  const unpaired = await openCollected(server.clientUrl('m1'));
  const paired = await openCollected(server.clientUrl('m1'));
  t.after(() => Promise.all([machine, unpaired, paired].map((item) => closeWs(item.socket))));

  const command = makeCommand('workspace.list', {});
  sendCommand(unpaired.socket, command);
  const rejected = await waitForResult(unpaired.frames, command.requestId);
  assert.equal(rejected.result.ok, false);
  assert.match(rejected.result.error, /Device is not paired/);
  await waitQuiet();
  assert.equal(machineCommands(machine.frames).length, 0);

  await pairClient(paired.socket, paired.frames, machine.socket, machine.frames, 'dev-pair');
  sendEvent(machine.socket, {
    eventId: 'evt-secret',
    sessionId: 'remote_sess',
    timestamp: new Date().toISOString(),
    type: 'assistant.message',
    payload: { text: 'secret', delta: true },
  });
  await waitUntil(() => paired.frames.some((frame) => frame.kind === 'event'));
  await waitQuiet();
  assert.equal(
    unpaired.frames.some((frame) => frame.kind === 'event'),
    false,
  );

  const listed = makeCommand('workspace.list', {});
  sendCommand(paired.socket, listed);
  await waitUntil(() => machineCommands(machine.frames).length === 1);
  sendResult(machine.socket, remoteCommandSuccess(listed.requestId, []));
  const result = await waitForResult(paired.frames, listed.requestId);
  assert.equal(result.result.ok, true);
});

test('wrong-key and replayed verification results leave the client unpaired', async (t) => {
  const server = await listen();
  t.after(() => server.close());
  const machine = await openCollected(server.machineUrl('m1'));
  const client = await openCollected(server.clientUrl('m1'));
  t.after(() => Promise.all([machine, client].map((item) => closeWs(item.socket))));

  const requestId = 'auth-wrong';
  const verify = await completeVerification(
    client.socket,
    client.frames,
    machine.socket,
    machine.frames,
    {
      kind: 'auth_proof',
      requestId,
      deviceId: 'dev-wrong',
      signature: fakeSignature(),
    },
  );
  machine.socket.send(
    serializeTransportFrame({
      kind: 'pairing_result',
      verificationId: verify.verificationId,
      ok: false,
      deviceId: null,
      error: 'Invalid authentication proof',
    }),
  );
  const failed = await waitForResult(client.frames, requestId);
  assert.equal(failed.result.ok, false);
  const challengeAfterFailure = lastKind(client.frames, 'auth_challenge');
  assert.notEqual(challengeAfterFailure.nonce, verify.nonce);

  const replayed = {
    kind: 'auth_proof',
    requestId: 'auth-replay',
    deviceId: 'dev-wrong',
    signature: fakeSignature(),
  };
  const replayVerify = await completeVerification(
    client.socket,
    client.frames,
    machine.socket,
    machine.frames,
    replayed,
  );
  assert.equal(replayVerify.nonce, challengeAfterFailure.nonce);
  assert.notEqual(replayVerify.nonce, verify.nonce);
  machine.socket.send(
    serializeTransportFrame({
      kind: 'pairing_result',
      verificationId: replayVerify.verificationId,
      ok: false,
      deviceId: null,
      error: 'Invalid authentication proof',
    }),
  );
  const replayFailed = await waitForResult(client.frames, 'auth-replay');
  assert.equal(replayFailed.result.ok, false);

  const command = makeCommand('workspace.list', {});
  sendCommand(client.socket, command);
  const unpaired = await waitForResult(client.frames, command.requestId);
  assert.equal(unpaired.result.ok, false);
  assert.match(unpaired.result.error, /Device is not paired/);
  await waitQuiet();
  assert.equal(machineCommands(machine.frames).length, 0);

  machine.socket.send(
    serializeTransportFrame({
      kind: 'pairing_result',
      verificationId: verify.verificationId,
      ok: true,
      deviceId: 'dev-wrong',
      error: null,
    }),
  );
  await waitQuiet();
  const later = makeCommand('session.list', { workspaceId: 'ws' });
  sendCommand(client.socket, later);
  const stillUnpaired = await waitForResult(client.frames, later.requestId);
  assert.match(stillUnpaired.result.error, /Device is not paired/);
  assert.equal(machineCommands(machine.frames).length, 0);

  await authenticateClient(client.socket, client.frames, machine.socket, machine.frames, 'dev-ok');
  const verifiesAfterAuth = machine.frames.filter(
    (frame) => frame.kind === 'pairing_verify',
  ).length;
  const extraAuthId = 'auth-after-success';
  client.socket.send(
    serializeTransportFrame({
      kind: 'auth_proof',
      requestId: extraAuthId,
      deviceId: 'dev-ok',
      signature: fakeSignature(),
    }),
  );
  const extraAuth = await waitForResult(client.frames, extraAuthId);
  assert.equal(extraAuth.result.ok, false);
  await waitQuiet();
  assert.equal(
    machine.frames.filter((frame) => frame.kind === 'pairing_verify').length,
    verifiesAfterAuth,
  );
});

test('machine disconnect settles pending work and requires a fresh proof', async (t) => {
  const server = await listen();
  t.after(() => server.close());
  const machine = await openCollected(server.machineUrl('m1'));
  const client = await openCollected(server.clientUrl('m1'));
  t.after(() => Promise.all([machine, client].map((item) => closeWs(item.socket))));

  await authenticateClient(client.socket, client.frames, machine.socket, machine.frames);
  const pending = makeCommand('session.send', { text: 'wait' });
  sendCommand(client.socket, pending);
  await waitUntil(() => machineCommands(machine.frames).length === 1);
  const challengesBefore = client.frames.filter((frame) => frame.kind === 'auth_challenge').length;
  machine.socket.close();

  const disconnected = await waitForResult(client.frames, pending.requestId);
  assert.equal(disconnected.result.ok, false);
  assert.match(disconnected.result.error, /Machine disconnected/);
  await waitUntil(
    () =>
      client.frames.filter((frame) => frame.kind === 'auth_challenge').length > challengesBefore,
  );

  const later = makeCommand('workspace.list', {});
  sendCommand(client.socket, later);
  const unpaired = await waitForResult(client.frames, later.requestId);
  assert.equal(unpaired.result.ok, false);
  assert.match(unpaired.result.error, /Device is not paired/);

  const replacement = await openCollected(server.machineUrl('m1'));
  t.after(() => closeWs(replacement.socket));
  await authenticateClient(client.socket, client.frames, replacement.socket, replacement.frames);
  const next = makeCommand('workspace.list', {});
  sendCommand(client.socket, next);
  await waitUntil(() => machineCommands(replacement.frames).length === 1);
  sendResult(replacement.socket, remoteCommandSuccess(next.requestId, []));
  const result = await waitForResult(client.frames, next.requestId);
  assert.equal(result.result.ok, true);
});

test('replacement machine supersedes the old socket and receives later commands', async (t) => {
  const server = await listen();
  t.after(() => server.close());
  const machine = await openCollected(server.machineUrl('m1'));
  const client = await openCollected(server.clientUrl('m1'));
  t.after(() => Promise.all([machine, client].map((item) => closeWs(item.socket))));

  await authenticateClient(client.socket, client.frames, machine.socket, machine.frames);
  const pending = makeCommand('workspace.list', {});
  sendCommand(client.socket, pending);
  await waitUntil(() => machineCommands(machine.frames).length === 1);

  const replacement = await openCollected(server.machineUrl('m1'));
  t.after(() => closeWs(replacement.socket));

  const replaced = await waitForResult(client.frames, pending.requestId);
  assert.equal(replaced.result.ok, false);
  assert.match(replaced.result.error, /Machine replaced/);

  await authenticateClient(client.socket, client.frames, replacement.socket, replacement.frames);
  const next = makeCommand('workspace.list', {});
  sendCommand(client.socket, next);
  await waitUntil(() => machineCommands(replacement.frames).length === 1);

  if (machine.socket.readyState === WebSocket.OPEN) {
    sendEvent(machine.socket, {
      eventId: 'evt-stale',
      sessionId: 'remote_sess',
      timestamp: new Date().toISOString(),
      type: 'assistant.message',
      payload: { text: 'stale', delta: true },
    });
    sendResult(machine.socket, remoteCommandSuccess(next.requestId, { leaked: true }));
    await waitQuiet();
  }
  assert.equal(
    client.frames.some((frame) => frame.kind === 'event' && frame.event.eventId === 'evt-stale'),
    false,
  );
  assert.equal(
    client.frames.some(
      (frame) =>
        frame.kind === 'result' &&
        frame.result.requestId === next.requestId &&
        frame.result.ok === true &&
        frame.result.value !== null &&
        typeof frame.result.value === 'object' &&
        'leaked' in frame.result.value,
    ),
    false,
  );

  sendResult(replacement.socket, remoteCommandSuccess(next.requestId, []));
  const result = await waitForResult(client.frames, next.requestId);
  assert.equal(result.result.ok, true);
  assert.deepEqual(result.result.value, []);
});
