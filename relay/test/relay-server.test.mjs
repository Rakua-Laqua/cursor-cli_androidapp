import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseRemoteFrame,
  remoteCommandSuccess,
  serializeRemoteFrame,
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

function collectFrames(socket) {
  const frames = [];
  socket.on('message', (data, isBinary) => {
    if (!isBinary) {
      frames.push(parseRemoteFrame(String(data)));
    }
  });
  return frames;
}

function collectCommands(socket) {
  const commands = [];
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      return;
    }
    const frame = parseRemoteFrame(String(data));
    if (frame.kind === 'command') {
      commands.push(frame.command);
    }
  });
  return commands;
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

test('routes results to the originating client and broadcasts events per machine', async (t) => {
  const server = await listen();
  t.after(() => server.close());
  const machine = await openWs(server.machineUrl('m1'));
  const otherMachine = await openWs(server.machineUrl('m2'));
  const clientA = await openWs(server.clientUrl('m1'));
  const clientB = await openWs(server.clientUrl('m1'));
  const otherClient = await openWs(server.clientUrl('m2'));
  t.after(() => Promise.all([machine, otherMachine, clientA, clientB, otherClient].map(closeWs)));

  const machineCommands = collectCommands(machine);
  const framesA = collectFrames(clientA);
  const framesB = collectFrames(clientB);
  const framesOther = collectFrames(otherClient);

  const command = makeCommand('workspace.list', {});
  sendCommand(clientA, command);
  await waitUntil(() => machineCommands.length === 1);
  assert.equal(machineCommands[0].requestId, command.requestId);

  sendResult(machine, remoteCommandSuccess(command.requestId, []));
  const result = await waitForResult(framesA, command.requestId);
  assert.equal(result.result.ok, true);
  assert.deepEqual(result.result.value, []);
  await waitQuiet();
  assert.equal(
    framesB.some(
      (frame) => frame.kind === 'result' && frame.result.requestId === command.requestId,
    ),
    false,
  );
  assert.equal(
    framesOther.some((frame) => frame.kind === 'result'),
    false,
  );

  const event = {
    eventId: 'evt-route',
    sessionId: 'remote_sess',
    timestamp: new Date().toISOString(),
    type: 'assistant.message',
    payload: { text: 'hi', delta: true },
  };
  sendEvent(machine, event);
  await waitUntil(
    () =>
      framesA.some((frame) => frame.kind === 'event') &&
      framesB.some((frame) => frame.kind === 'event'),
  );
  assert.equal(framesA.find((frame) => frame.kind === 'event').event.eventId, 'evt-route');
  assert.equal(framesB.find((frame) => frame.kind === 'event').event.eventId, 'evt-route');
  await waitQuiet();
  assert.equal(
    framesOther.some((frame) => frame.kind === 'event'),
    false,
  );
  otherMachine.send(Buffer.from('ignored'));
});

test('rejects duplicate request ids and ignores unknown result correlations', async (t) => {
  const server = await listen();
  t.after(() => server.close());
  const machine = await openWs(server.machineUrl('m1'));
  const clientA = await openWs(server.clientUrl('m1'));
  const clientB = await openWs(server.clientUrl('m1'));
  t.after(() => Promise.all([machine, clientA, clientB].map(closeWs)));

  const machineCommands = collectCommands(machine);
  const framesA = collectFrames(clientA);
  const framesB = collectFrames(clientB);
  const command = makeCommand('workspace.list', {}, 'dup-1');

  sendCommand(clientA, command);
  await waitUntil(() => machineCommands.length === 1);
  sendCommand(clientB, command);
  const duplicate = await waitForResult(framesB, 'dup-1');
  assert.equal(duplicate.result.ok, false);
  assert.match(duplicate.result.error, /Duplicate request id/);
  assert.equal(machineCommands.length, 1);

  sendResult(machine, remoteCommandSuccess('dup-1', null));
  const original = await waitForResult(framesA, 'dup-1');
  assert.equal(original.result.ok, true);
  assert.equal(
    framesB.filter((frame) => frame.kind === 'result' && frame.result.requestId === 'dup-1').length,
    1,
  );

  sendResult(machine, remoteCommandSuccess('never-seen', { leaked: true }));
  await waitQuiet();
  assert.equal(
    framesA.some((frame) => frame.result?.requestId === 'never-seen'),
    false,
  );
  assert.equal(
    framesB.some((frame) => frame.result?.requestId === 'never-seen'),
    false,
  );
});

test('ignores binary frames and still routes a later command', async (t) => {
  const server = await listen();
  t.after(() => server.close());
  const machine = await openWs(server.machineUrl('m1'));
  const client = await openWs(server.clientUrl('m1'));
  t.after(() => Promise.all([machine, client].map(closeWs)));

  const machineCommands = collectCommands(machine);
  const frames = collectFrames(client);
  client.send(Buffer.from('{"kind":"command"}'), { binary: true });
  machine.send(Buffer.from('{"kind":"event"}'), { binary: true });
  await waitQuiet();

  const command = makeCommand('workspace.list', {});
  sendCommand(client, command);
  await waitUntil(() => machineCommands.length === 1);
  sendResult(machine, remoteCommandSuccess(command.requestId, []));
  const result = await waitForResult(frames, command.requestId);
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

test('machine disconnect settles pending work and offline commands error', async (t) => {
  const server = await listen();
  t.after(() => server.close());
  const machine = await openWs(server.machineUrl('m1'));
  const client = await openWs(server.clientUrl('m1'));
  t.after(() => Promise.all([machine, client].map(closeWs)));

  const machineCommands = collectCommands(machine);
  const frames = collectFrames(client);
  const pending = makeCommand('session.send', { text: 'wait' });
  sendCommand(client, pending);
  await waitUntil(() => machineCommands.length === 1);
  machine.close();

  const disconnected = await waitForResult(frames, pending.requestId);
  assert.equal(disconnected.result.ok, false);
  assert.match(disconnected.result.error, /Machine disconnected/);

  const later = makeCommand('workspace.list', {});
  sendCommand(client, later);
  const offline = await waitForResult(frames, later.requestId);
  assert.equal(offline.result.ok, false);
  assert.match(offline.result.error, /Machine is offline/);
});

test('replacement machine supersedes the old socket and receives later commands', async (t) => {
  const server = await listen();
  t.after(() => server.close());
  const machine = await openWs(server.machineUrl('m1'));
  const client = await openWs(server.clientUrl('m1'));
  t.after(() => Promise.all([machine, client].map(closeWs)));

  const machineCommands = collectCommands(machine);
  const frames = collectFrames(client);
  const pending = makeCommand('workspace.list', {});
  sendCommand(client, pending);
  await waitUntil(() => machineCommands.length === 1);

  const replacement = await openWs(server.machineUrl('m1'));
  const replacementCommands = collectCommands(replacement);
  t.after(() => closeWs(replacement));

  const replaced = await waitForResult(frames, pending.requestId);
  assert.equal(replaced.result.ok, false);
  assert.match(replaced.result.error, /Machine replaced/);

  const next = makeCommand('workspace.list', {});
  sendCommand(client, next);
  await waitUntil(() => replacementCommands.length === 1);

  if (machine.readyState === WebSocket.OPEN) {
    sendEvent(machine, {
      eventId: 'evt-stale',
      sessionId: 'remote_sess',
      timestamp: new Date().toISOString(),
      type: 'assistant.message',
      payload: { text: 'stale', delta: true },
    });
    sendResult(machine, remoteCommandSuccess(next.requestId, { leaked: true }));
    await waitQuiet();
  }
  assert.equal(
    frames.some((frame) => frame.kind === 'event' && frame.event.eventId === 'evt-stale'),
    false,
  );
  assert.equal(
    frames.some(
      (frame) =>
        frame.kind === 'result' &&
        frame.result.requestId === next.requestId &&
        frame.result.ok === true,
    ),
    false,
  );

  sendResult(replacement, remoteCommandSuccess(next.requestId, []));
  const result = await waitForResult(frames, next.requestId);
  assert.equal(result.result.ok, true);
  assert.deepEqual(result.result.value, []);
});
