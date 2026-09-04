import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseTransportFrame,
  serializeRemoteFrame,
  serializeTransportFrame,
} from '@cursor-remote/protocol';
import { WebSocket } from 'ws';

import {
  createFcmSenderFromEnv,
  createHttpV1FcmSender,
  PushDispatcher,
  RelayServer,
} from '../dist/index.js';

const SIG = Buffer.alloc(32, 9).toString('base64url');

function eventOf(type, eventId, sessionId = 'sess-1') {
  return { eventId, sessionId, timestamp: '2026-09-04T00:00:00.000Z', type, payload: {} };
}

function dataOf(type, eventId) {
  return { eventId, type, machineId: 'm1', sessionId: 'sess-1' };
}

function recordingSender(handler) {
  const calls = [];
  return {
    calls,
    sender: {
      async send(token, data) {
        calls.push({ token, data });
        return handler === undefined ? 'sent' : handler();
      },
    },
  };
}

function fakeSchedule() {
  const tasks = [];
  return {
    tasks,
    schedule(delayMs, action) {
      const task = { delayMs, action, cancelled: false };
      tasks.push(task);
      return { cancel: () => void (task.cancelled = true) };
    },
  };
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function closeWs(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => {
    socket.once('close', resolve);
    if (socket.readyState !== WebSocket.CLOSING) socket.close();
  });
}

async function openCollected(url) {
  const socket = new WebSocket(url);
  const frames = [];
  socket.on('message', (data, isBinary) => {
    if (!isBinary) frames.push(parseTransportFrame(String(data)));
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, frames };
}

async function paired(t, extra = {}) {
  const rec = recordingSender();
  const server = await RelayServer.listen({
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: 0,
    fcmSender: extra.fcmSender ?? rec.sender,
  });
  t.after(() => server.close());
  const machine = await openCollected(server.machineUrl('m1'));
  const client = await openCollected(server.clientUrl('m1'));
  t.after(() => Promise.all([machine, client].map((item) => closeWs(item.socket))));
  return { rec, machine, client };
}

async function waitForResult(frames, requestId) {
  await waitUntil(() =>
    frames.some((f) => f.kind === 'result' && f.result.requestId === requestId),
  );
  return frames.find((f) => f.kind === 'result' && f.result.requestId === requestId);
}

async function authenticate(client, machine, deviceId = 'dev-1') {
  await waitUntil(() => client.frames.some((frame) => frame.kind === 'auth_challenge'));
  const requestId = `auth-${deviceId}`;
  const before = machine.frames.filter((frame) => frame.kind === 'pairing_verify').length;
  client.socket.send(
    serializeTransportFrame({ kind: 'auth_proof', requestId, deviceId, signature: SIG }),
  );
  await waitUntil(
    () => machine.frames.filter((frame) => frame.kind === 'pairing_verify').length > before,
  );
  const verify = [...machine.frames].reverse().find((frame) => frame.kind === 'pairing_verify');
  machine.socket.send(
    serializeTransportFrame({
      kind: 'pairing_result',
      verificationId: verify.verificationId,
      ok: true,
      deviceId,
      error: null,
    }),
  );
  assert.equal((await waitForResult(client.frames, requestId)).result.ok, true);
}

function sendRegister(socket, requestId, fcmToken, appForeground) {
  socket.send(
    serializeTransportFrame({ kind: 'transport_register', requestId, fcmToken, appForeground }),
  );
}

function registerPush(push, token = 'tok.1') {
  push.register({
    machineId: 'm1',
    deviceId: 'd1',
    fcmToken: token,
    appForeground: false,
    connection: {},
  });
}

function httpSender(fetchImpl, extra = {}) {
  return createHttpV1FcmSender({
    projectId: 'proj-1',
    getAccessToken: () => extra.token ?? 'access-1',
    fetchImpl,
    timeoutMs: extra.timeoutMs,
  });
}

test('transport_register is local, authenticated, and never echoes or forwards the token', async (t) => {
  const { machine, client } = await paired(t);
  const token = 'reg.token-1';
  sendRegister(client.socket, 'reg-unauth', token, false);
  const unpaired = await waitForResult(client.frames, 'reg-unauth');
  assert.equal(unpaired.result.ok, false);
  assert.match(unpaired.result.error, /Device is not paired/);
  assert.equal(JSON.stringify(unpaired).includes(token), false);
  assert.ok(!machine.frames.some((frame) => frame.kind === 'transport_register'));

  await authenticate(client, machine);
  client.socket.send(
    serializeRemoteFrame({
      kind: 'command',
      command: {
        requestId: 'held-1',
        sessionId: null,
        timestamp: new Date().toISOString(),
        type: 'workspace.list',
        payload: {},
      },
    }),
  );
  await waitUntil(() =>
    machine.frames.some(
      (frame) => frame.kind === 'command' && frame.command.requestId === 'held-1',
    ),
  );
  sendRegister(client.socket, 'held-1', token, false);
  const duplicate = await waitForResult(client.frames, 'held-1');
  assert.equal(duplicate.result.ok, false);
  assert.match(duplicate.result.error, /Duplicate request id/);
  assert.equal(JSON.stringify(duplicate).includes(token), false);

  sendRegister(client.socket, 'reg-ok', token, false);
  const registered = await waitForResult(client.frames, 'reg-ok');
  assert.equal(registered.result.ok, true);
  assert.deepEqual(registered.result.value, { registered: true });
  assert.equal(JSON.stringify(registered).includes(token), false);
  assert.ok(!machine.frames.some((frame) => JSON.stringify(frame).includes(token)));
});

test('background FCM delivers after disconnect and skips foreground', async (t) => {
  const { rec, machine, client } = await paired(t);
  await authenticate(client, machine, 'dev-a');
  sendRegister(client.socket, 'reg-fg', 'tok.fg', true);
  await waitForResult(client.frames, 'reg-fg');
  machine.socket.send(
    serializeRemoteFrame({ kind: 'event', event: eventOf('permission.requested', 'e-fg') }),
  );
  await waitUntil(() => client.frames.some((frame) => frame.kind === 'event'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(rec.calls.length, 0);
  sendRegister(client.socket, 'reg-bg', 'tok.bg', false);
  await waitForResult(client.frames, 'reg-bg');
  await closeWs(client.socket);
  machine.socket.send(
    serializeRemoteFrame({ kind: 'event', event: eventOf('agent.completed', 'e-disc') }),
  );
  await waitUntil(() => rec.calls.length === 1);
  assert.equal(rec.calls[0].token, 'tok.bg');
  assert.equal(Object.keys(rec.calls[0].data).sort().join(), 'eventId,machineId,sessionId,type');
});

test('immediate types, 60s waiting, cancellation, duplicates, dispose, UNREGISTERED, null token', async () => {
  const rec = recordingSender();
  const clock = fakeSchedule();
  const push = new PushDispatcher({ sender: rec.sender, schedule: clock.schedule.bind(clock) });
  registerPush(push);
  push.onEvent('m1', eventOf('assistant.message', 'e-perm'));
  for (const [type, id] of [
    ['permission.requested', 'e-perm'],
    ['agent.completed', 'e-done'],
    ['agent.failed', 'e-fail'],
  ]) {
    push.onEvent('m1', eventOf(type, id));
  }
  await waitUntil(() => rec.calls.length === 3);
  assert.deepEqual(
    rec.calls.map((call) => call.data.type),
    ['permission.requested', 'agent.completed', 'agent.failed'],
  );
  rec.calls.length = 0;
  push.onEvent('m1', eventOf('agent.waiting', 'e-wait'));
  assert.equal(clock.tasks[0].delayMs, 60_000);
  clock.tasks[0].action();
  await waitUntil(() => rec.calls.length === 1);
  rec.calls.length = 0;
  push.onEvent('m1', eventOf('agent.waiting', 'e-wait-2'));
  push.onEvent('m1', eventOf('permission.requested', 'e-perm-2'));
  assert.equal(clock.tasks[1].cancelled, true);
  await waitUntil(() => rec.calls.some((call) => call.data.type === 'permission.requested'));
  clock.tasks[1].action();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(rec.calls.filter((call) => call.data.type === 'agent.waiting').length, 0);
  rec.calls.length = 0;
  push.onEvent('m1', eventOf('agent.completed', 'e-done'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(rec.calls.length, 0);
  push.onEvent('m1', eventOf('agent.waiting', 'e-wait-3'));
  push.onEvent('m1', eventOf('permission.resolved', 'e-res'));
  push.onEvent('m1', eventOf('agent.waiting', 'e-wait-4'));
  push.onEvent('m1', eventOf('agent.interrupted', 'e-int'));
  assert.equal(clock.tasks.at(-1).cancelled, true);
  rec.calls.length = 0;
  push.onEvent('m1', eventOf('agent.completed', 'e-res'));
  push.onEvent('m1', eventOf('permission.requested', 'e-int'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(rec.calls.length, 0);

  const disposed = recordingSender();
  const clock2 = fakeSchedule();
  const dying = new PushDispatcher({
    sender: disposed.sender,
    schedule: clock2.schedule.bind(clock2),
  });
  registerPush(dying, 'tok.x');
  dying.onEvent('m1', eventOf('agent.waiting', 'e-w'));
  dying.dispose();
  clock2.tasks[0].action();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disposed.calls.length, 0);

  const dropped = recordingSender(() => 'drop-token');
  const live = new PushDispatcher({ sender: dropped.sender });
  registerPush(live, 'tok.drop');
  live.onEvent('m1', eventOf('agent.failed', 'e-1'));
  await waitUntil(() => dropped.calls.length === 1);
  live.onEvent('m1', eventOf('agent.failed', 'e-2'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(dropped.calls.length, 1);

  const cleared = recordingSender();
  const registry = new PushDispatcher({ sender: cleared.sender });
  registerPush(registry, 'tok.keep');
  registerPush(registry, null);
  registry.onEvent('m1', eventOf('agent.completed', 'e-null'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cleared.calls.length, 0);

  let unlock;
  const raced = [];
  const racing = new PushDispatcher({
    sender: {
      async send(token) {
        raced.push(token);
        if (token !== 'tok.old') return 'sent';
        await new Promise((resolve) => {
          unlock = resolve;
        });
        return 'drop-token';
      },
    },
  });
  registerPush(racing, 'tok.old');
  racing.onEvent('m1', eventOf('agent.completed', 'e-old'));
  await waitUntil(() => raced[0] === 'tok.old');
  registerPush(racing, 'tok.new');
  unlock();
  await new Promise((resolve) => setTimeout(resolve, 20));
  racing.onEvent('m1', eventOf('agent.failed', 'e-new'));
  await waitUntil(() => raced.includes('tok.new'));
});

test('sender failure does not block WebSocket broadcast', async (t) => {
  let release;
  const { machine, client } = await paired(t, {
    fcmSender: {
      send: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
  });
  await authenticate(client, machine);
  sendRegister(client.socket, 'reg', 'tok.hang', false);
  await waitForResult(client.frames, 'reg');
  machine.socket.send(
    serializeRemoteFrame({ kind: 'event', event: eventOf('permission.requested', 'e-live') }),
  );
  await waitUntil(() =>
    client.frames.some((frame) => frame.kind === 'event' && frame.event.eventId === 'e-live'),
  );
  release('retryable');
});

test('HTTP v1 sender posts data-only HIGH messages, rotates tokens, and fails closed', async () => {
  const captured = [];
  const env = { FCM_PROJECT_ID: 'proj-1', FCM_ACCESS_TOKEN: 'access-1' };
  assert.equal(createFcmSenderFromEnv({}), undefined);
  assert.equal(createFcmSenderFromEnv({ FCM_PROJECT_ID: 'proj-1' }), undefined);
  const sender = createFcmSenderFromEnv(env, {
    fetchImpl: async (url, init) => {
      captured.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => '{}' };
    },
  });
  assert.equal(await sender.send('tok.dest', dataOf('agent.completed', 'e-http')), 'sent');
  env.FCM_ACCESS_TOKEN = 'access-2';
  await sender.send('tok.dest', dataOf('agent.failed', 'e-http-2'));
  assert.equal(captured[0].url, 'https://fcm.googleapis.com/v1/projects/proj-1/messages:send');
  assert.equal(captured[0].init.headers.Authorization, 'Bearer access-1');
  assert.equal(captured[1].init.headers.Authorization, 'Bearer access-2');
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.message.android.priority, 'HIGH');
  assert.deepEqual(body.message.data, dataOf('agent.completed', 'e-http'));
  assert.equal('notification' in body.message, false);
  assert.equal(
    await httpSender(async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: { details: [{ errorCode: 'UNREGISTERED' }] } }),
    })).send('tok.dest', dataOf('agent.failed', 'e-u')),
    'drop-token',
  );
  const started = Date.now();
  assert.equal(
    await httpSender(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
      { token: 'access-secret', timeoutMs: 20 },
    ).send('tok.dest', dataOf('agent.completed', 'e-t')),
    'retryable',
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(
    await httpSender(
      async () => {
        throw new Error('failed access-secret tok.dest');
      },
      {
        token: 'access-secret',
      },
    ).send('tok.dest', dataOf('agent.completed', 'e-l')),
    'retryable',
  );
});
