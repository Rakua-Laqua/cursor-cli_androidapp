import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseRemoteCommand, serializeCommand } from '@cursor-remote/protocol';

import { AcpProcessExitedError, Daemon } from '../dist/index.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-acp.mjs');

function mockLaunch() {
  return {
    command: process.execPath,
    args: [fixture],
  };
}

async function withDaemon(fn, acpExtra = {}) {
  const daemon = await Daemon.start({
    acp: {
      ...mockLaunch(),
      shutdownTimeoutMs: 1000,
      ...acpExtra,
    },
    workspaces: { allowedRoots: [os.tmpdir()] },
  });
  try {
    await fn(daemon);
  } finally {
    await daemon.stop();
  }
}

function registerWorkspace(daemon, workspacePath) {
  return daemon.workspaces.register(workspacePath);
}

async function createIdleSession(daemon, workspacePath, title = null) {
  const registered = registerWorkspace(daemon, workspacePath);
  const created = await daemon.sessions.create({
    workspaceId: registered.workspaceId,
    initialPrompt: '',
    title,
  });
  return { registered, created };
}

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acp-ws-'));
}

function collectEvents(daemon) {
  const events = [];
  daemon.sessions.onEvent((event) => events.push(event));
  return events;
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

function joinedAssistantText(events) {
  return events
    .filter((event) => event.type === 'assistant.message')
    .map((event) => event.payload.text)
    .join('');
}

const TERMINAL_EVENT_TYPES = new Set(['agent.completed', 'agent.failed', 'agent.interrupted']);

function terminalEvents(events) {
  return events.filter((event) => TERMINAL_EVENT_TYPES.has(event.type));
}

function countStatus(events, status) {
  return events.filter(
    (event) => event.type === 'session.status_changed' && event.payload.status === status,
  ).length;
}

test('session.create rejects an unknown workspaceId', async () => {
  await withDaemon(async (daemon) => {
    await assert.rejects(
      () =>
        daemon.sessions.create({
          workspaceId: 'missing',
          initialPrompt: '',
          title: null,
        }),
      /Unknown workspace/,
    );
  });
});

test('local client can create, stream, end, load, and continue a session', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(async (daemon) => {
    const events = collectEvents(daemon);
    const { registered, created } = await createIdleSession(daemon, workspacePath, 'probe');

    assert.equal(created.status, 'idle');
    assert.equal(created.title, 'probe');
    assert.equal(created.workspaceId, registered.workspaceId);
    assert.ok(created.remoteSessionId);
    assert.ok(created.cursorSessionId);
    assert.ok(events.some((event) => event.type === 'session.created'));

    await daemon.sessions.send(created.remoteSessionId, 'hello');
    const messages = events.filter((event) => event.type === 'assistant.message');
    assert.ok(messages.length >= 2);
    assert.equal(
      messages.every((event) => event.payload.delta === true),
      true,
    );
    assert.equal(joinedAssistantText(events), 'echo:hello');
    assert.equal(terminalEvents(events).length, 1);
    assert.equal(terminalEvents(events)[0].type, 'agent.completed');
    assert.ok(events.some((event) => event.type === 'assistant.status'));

    const loaded = await daemon.sessions.load(created.remoteSessionId);
    assert.equal(loaded.remoteSessionId, created.remoteSessionId);
    assert.equal(loaded.cursorSessionId, created.cursorSessionId);
    assert.equal(loaded.status, 'idle');
    assert.ok(events.some((event) => event.type === 'session.loaded'));

    await daemon.sessions.send(created.remoteSessionId, 'follow-up');
    assert.match(joinedAssistantText(events), /echo:follow-up/);
    assert.equal(events.filter((event) => event.type === 'agent.completed').length, 2);
    assert.equal(terminalEvents(events).length, 2);
  });
});

test('session.cancel interrupts a delayed prompt', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(async (daemon) => {
    const events = collectEvents(daemon);
    const { created } = await createIdleSession(daemon, workspacePath);
    assert.equal(created.title, 'Session');

    const sending = daemon.sessions.send(created.remoteSessionId, 'DELAY');
    await waitUntil(() =>
      events.some(
        (event) => event.type === 'assistant.status' && event.payload.status === 'thinking',
      ),
    );
    await daemon.sessions.cancel(created.remoteSessionId);
    await sending;

    assert.ok(events.some((event) => event.type === 'agent.interrupted'));
    assert.equal(terminalEvents(events).length, 1);
    assert.equal(terminalEvents(events)[0].type, 'agent.interrupted');
  });
});

test('handleCommand covers create, send, cancel, and load', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(async (daemon) => {
    const events = collectEvents(daemon);
    const registered = registerWorkspace(daemon, workspacePath);
    const created = await daemon.sessions.handleCommand(
      parseRemoteCommand(
        serializeCommand({
          requestId: 'req-create',
          sessionId: null,
          timestamp: new Date().toISOString(),
          type: 'session.create',
          payload: {
            workspaceId: registered.workspaceId,
            initialPrompt: 'from-command',
            title: null,
          },
        }),
      ),
    );

    assert.ok(created);
    assert.equal(created.status, 'completed');
    assert.equal(joinedAssistantText(events), 'echo:from-command');

    await daemon.sessions.handleCommand(
      parseRemoteCommand(
        serializeCommand({
          requestId: 'req-load',
          sessionId: null,
          timestamp: new Date().toISOString(),
          type: 'session.load',
          payload: { remoteSessionId: created.remoteSessionId },
        }),
      ),
    );

    const thinkingBefore = events.filter(
      (event) => event.type === 'assistant.status' && event.payload.status === 'thinking',
    ).length;
    const sending = daemon.sessions.handleCommand(
      parseRemoteCommand(
        serializeCommand({
          requestId: 'req-send',
          sessionId: created.remoteSessionId,
          timestamp: new Date().toISOString(),
          type: 'session.send',
          payload: { text: 'DELAY' },
        }),
      ),
    );
    await waitUntil(
      () =>
        events.filter(
          (event) => event.type === 'assistant.status' && event.payload.status === 'thinking',
        ).length > thinkingBefore,
    );
    await daemon.sessions.handleCommand(
      parseRemoteCommand(
        serializeCommand({
          requestId: 'req-cancel',
          sessionId: created.remoteSessionId,
          timestamp: new Date().toISOString(),
          type: 'session.cancel',
          payload: {},
        }),
      ),
    );
    await sending;
    assert.equal(terminalEvents(events).length, 2);
    assert.equal(events.filter((event) => event.type === 'agent.completed').length, 1);
    assert.equal(events.filter((event) => event.type === 'agent.interrupted').length, 1);
  });
});

test('ACP crash during a prompt emits exactly one agent.failed', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(async (daemon) => {
    const events = collectEvents(daemon);
    const { created } = await createIdleSession(daemon, workspacePath);

    const sending = daemon.sessions.send(created.remoteSessionId, 'DELAY');
    await waitUntil(() =>
      events.some(
        (event) => event.type === 'assistant.status' && event.payload.status === 'thinking',
      ),
    );
    await daemon.acp.request('crash').catch(() => {});
    await assert.rejects(sending, AcpProcessExitedError);

    const failed = events.filter((event) => event.type === 'agent.failed');
    assert.equal(failed.length, 1);
    assert.equal(countStatus(events, 'failed'), 1);
    assert.equal(terminalEvents(events).length, 1);
    assert.match(failed[0].payload.reason ?? '', /ACP process exited|exited/);
  });
});

test('concurrent session.create shares a single handshake', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(async (daemon) => {
    const registered = registerWorkspace(daemon, workspacePath);
    const [first, second] = await Promise.all([
      daemon.sessions.create({
        workspaceId: registered.workspaceId,
        initialPrompt: '',
        title: 'a',
      }),
      daemon.sessions.create({
        workspaceId: registered.workspaceId,
        initialPrompt: '',
        title: 'b',
      }),
    ]);
    assert.notEqual(first.remoteSessionId, second.remoteSessionId);
    assert.notEqual(first.cursorSessionId, second.cursorSessionId);

    const stats = await daemon.acp.request('debug-stats');
    assert.equal(stats.initializeCount, 1);
    assert.equal(stats.authenticateCount, 1);
  });
});

test('failed handshake can be retried', async () => {
  const workspacePath = makeWorkspace();
  const daemon = await Daemon.start({
    acp: {
      ...mockLaunch(),
      shutdownTimeoutMs: 1000,
      env: {
        ...process.env,
        MOCK_ACP_FAIL_INITIALIZE: '1',
      },
    },
    workspaces: { allowedRoots: [os.tmpdir()] },
  });
  try {
    const registered = registerWorkspace(daemon, workspacePath);
    await assert.rejects(
      () =>
        daemon.sessions.create({
          workspaceId: registered.workspaceId,
          initialPrompt: '',
          title: null,
        }),
      /initialize failed/,
    );
    const created = await daemon.sessions.create({
      workspaceId: registered.workspaceId,
      initialPrompt: '',
      title: null,
    });
    assert.ok(created.remoteSessionId);
    const stats = await daemon.acp.request('debug-stats');
    assert.equal(stats.initializeCount, 2);
    assert.equal(stats.authenticateCount, 1);
  } finally {
    await daemon.stop();
  }
});

test('send and load are rejected while a prompt is in progress', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(async (daemon) => {
    const events = collectEvents(daemon);
    const { created } = await createIdleSession(daemon, workspacePath);

    const sending = daemon.sessions.send(created.remoteSessionId, 'DELAY');
    await waitUntil(() =>
      events.some(
        (event) => event.type === 'assistant.status' && event.payload.status === 'thinking',
      ),
    );

    await assert.rejects(
      () => daemon.sessions.send(created.remoteSessionId, 'hello'),
      /prompt in progress/,
    );
    await assert.rejects(() => daemon.sessions.load(created.remoteSessionId), /prompt in progress/);

    await daemon.sessions.cancel(created.remoteSessionId);
    await sending;
    assert.equal(terminalEvents(events).length, 1);
    assert.equal(terminalEvents(events)[0].type, 'agent.interrupted');
  });
});

function permissionCommand(type, sessionId, permissionId, requestId = `req-${type}`) {
  return parseRemoteCommand(
    serializeCommand({
      requestId,
      sessionId,
      timestamp: new Date().toISOString(),
      type,
      payload: { permissionId },
    }),
  );
}

async function waitForPermissionRequested(events) {
  await waitUntil(() => events.some((event) => event.type === 'permission.requested'));
  return events.find((event) => event.type === 'permission.requested');
}

test('ASK_PERMISSION approve continues the turn with allow-once only', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(async (daemon) => {
    const events = collectEvents(daemon);
    const { created } = await createIdleSession(daemon, workspacePath);
    const sending = daemon.sessions.send(created.remoteSessionId, 'ASK_PERMISSION');
    const requested = await waitForPermissionRequested(events);
    assert.equal(requested.payload.risk, 'high');
    assert.equal(requested.payload.command, 'Get-ChildItem -Force');
    assert.equal(requested.payload.kind, 'execute');
    assert.equal(daemon.workspaces.require(created.workspaceId).activeSessionCount, 1);
    assert.equal(
      events.some(
        (event) =>
          event.type === 'session.status_changed' && event.payload.status === 'waiting_approval',
      ),
      true,
    );
    await daemon.sessions.handleCommand(
      permissionCommand(
        'permission.approve',
        created.remoteSessionId,
        requested.payload.permissionId,
      ),
    );
    await sending;
    assert.match(joinedAssistantText(events), /echo:ASK_PERMISSION:allow-once/);
    assert.equal(joinedAssistantText(events).includes('allow-always'), false);
    const resolved = events.filter((event) => event.type === 'permission.resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].payload.permissionId, requested.payload.permissionId);
    assert.equal(resolved[0].payload.decision, 'approved');
    assert.equal(terminalEvents(events).length, 1);
    assert.equal(terminalEvents(events)[0].type, 'agent.completed');
    assert.equal(daemon.workspaces.require(created.workspaceId).activeSessionCount, 0);
    assert.equal(countStatus(events, 'waiting_approval'), 1);
    assert.ok(countStatus(events, 'running') >= 2);
  });
});

test('ASK_PERMISSION reject and cancel fail closed then finish the session', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(async (daemon) => {
    const events = collectEvents(daemon);
    const { created } = await createIdleSession(daemon, workspacePath);
    const sending = daemon.sessions.send(created.remoteSessionId, 'ASK_PERMISSION');
    const requested = await waitForPermissionRequested(events);
    await daemon.sessions.handleCommand(
      permissionCommand(
        'permission.reject',
        created.remoteSessionId,
        requested.payload.permissionId,
      ),
    );
    await sending;
    assert.match(joinedAssistantText(events), /echo:ASK_PERMISSION:reject-once/);
    assert.equal(
      events.find((event) => event.type === 'permission.resolved')?.payload.decision,
      'rejected',
    );
    assert.equal(terminalEvents(events)[0].type, 'agent.completed');
    assert.equal(daemon.workspaces.require(created.workspaceId).activeSessionCount, 0);

    const before = events.length;
    const cancelling = daemon.sessions.send(created.remoteSessionId, 'ASK_PERMISSION');
    await waitUntil(() =>
      events.slice(before).some((event) => event.type === 'permission.requested'),
    );
    const second = events.filter((event) => event.type === 'permission.requested').at(-1);
    await daemon.sessions.cancel(created.remoteSessionId);
    await cancelling;
    assert.equal(
      events.filter((event) => event.type === 'permission.resolved').at(-1)?.payload.decision,
      'rejected',
    );
    assert.equal(events.filter((event) => event.type === 'agent.interrupted').length, 1);
    assert.equal(daemon.workspaces.require(created.workspaceId).activeSessionCount, 0);
    assert.equal(second.payload.permissionId.length > 0, true);
  });
});

test('permission decisions reject unknown, mismatched, and double commands without a second ACP outcome', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(async (daemon) => {
    const events = collectEvents(daemon);
    const { created } = await createIdleSession(daemon, workspacePath);
    const sending = daemon.sessions.send(created.remoteSessionId, 'ASK_PERMISSION');
    const requested = await waitForPermissionRequested(events);
    const permissionId = requested.payload.permissionId;
    await assert.rejects(
      () =>
        daemon.sessions.handleCommand(
          permissionCommand('permission.approve', created.remoteSessionId, 'missing-perm'),
        ),
      /Unknown permission/,
    );
    await assert.rejects(
      () =>
        daemon.sessions.handleCommand(
          permissionCommand('permission.approve', 'other-session', permissionId),
        ),
      /Unknown session|Permission session mismatch/,
    );
    await daemon.sessions.handleCommand(
      permissionCommand('permission.approve', created.remoteSessionId, permissionId),
    );
    await assert.rejects(
      () =>
        daemon.sessions.handleCommand(
          permissionCommand(
            'permission.reject',
            created.remoteSessionId,
            permissionId,
            'req-double',
          ),
        ),
      /Permission already decided/,
    );
    await sending;
    assert.equal(events.filter((event) => event.type === 'permission.resolved').length, 1);
    assert.match(joinedAssistantText(events), /echo:ASK_PERMISSION:allow-once/);
  });
});

test('session/prompt keeps waiting for permission beyond the default ACP request timeout', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(
    async (daemon) => {
      const events = collectEvents(daemon);
      const { created } = await createIdleSession(daemon, workspacePath);
      const sending = daemon.sessions.send(created.remoteSessionId, 'ASK_PERMISSION');
      const requested = await waitForPermissionRequested(events);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await daemon.sessions.handleCommand(
        permissionCommand(
          'permission.approve',
          created.remoteSessionId,
          requested.payload.permissionId,
        ),
      );
      await sending;
      assert.equal(terminalEvents(events)[0].type, 'agent.completed');
    },
    { requestTimeoutMs: 200 },
  );
});

test('unknown incoming ACP methods are rejected without blocking the session adapter', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(async (daemon) => {
    await assert.rejects(
      () =>
        daemon.sessions.handleIncomingRequest({
          id: 99,
          method: 'cursor/ask_question',
          params: {},
        }),
      /Method not found: cursor\/ask_question/,
    );
    const { created } = await createIdleSession(daemon, workspacePath);
    await daemon.sessions.send(created.remoteSessionId, 'hello');
    assert.equal(created.remoteSessionId.length > 0, true);
  });
});

function observedPermissionParams(cursorSessionId) {
  return {
    sessionId: cursorSessionId,
    toolCall: {
      toolCallId: 'tool_perm_1',
      title: 'Get-ChildItem -Force',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'Get-ChildItem -Force' },
    },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  };
}

test('idle and completed sessions fail closed instead of waiting for permission', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(async (daemon) => {
    const events = collectEvents(daemon);
    const { created } = await createIdleSession(daemon, workspacePath);
    const idleResult = await daemon.sessions.handleIncomingRequest({
      id: 'idle-perm',
      method: 'session/request_permission',
      params: observedPermissionParams(created.cursorSessionId),
    });
    assert.deepEqual(idleResult, {
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    });
    assert.equal(
      events.some((event) => event.type === 'permission.requested'),
      false,
    );

    await daemon.sessions.send(created.remoteSessionId, 'hello');
    const completedResult = await daemon.sessions.handleIncomingRequest({
      id: 'done-perm',
      method: 'session/request_permission',
      params: observedPermissionParams(created.cursorSessionId),
    });
    assert.deepEqual(completedResult, {
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    });
    assert.equal(events.filter((event) => event.type === 'permission.requested').length, 0);
  });
});

function modelCommand(type, sessionId, payload = {}, requestId = `req-${type}`) {
  return parseRemoteCommand(
    serializeCommand({
      requestId,
      sessionId,
      timestamp: new Date().toISOString(),
      type,
      payload,
    }),
  );
}

test('model.list exposes fixture catalog without production model ids and select confirms a catalog model', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(async (daemon) => {
    const events = collectEvents(daemon);
    const { created } = await createIdleSession(daemon, workspacePath);
    const listed = await daemon.sessions.handleCommand(
      modelCommand('model.list', created.remoteSessionId),
    );
    const ids = listed.models.map((model) => model.id);
    assert.deepEqual(ids.includes('mock-model'), true);
    assert.deepEqual(ids.includes('mock-fast'), true);
    assert.deepEqual(ids.includes('fixture-added-model'), true);
    assert.equal(
      listed.models.find((model) => model.id === 'fixture-added-model')?.displayName,
      'fixture-added-model',
    );
    assert.equal(listed.currentModelId, 'mock-model');
    assert.ok(events.some((event) => event.type === 'model.catalog_updated'));

    const selected = await daemon.sessions.handleCommand(
      modelCommand('model.select', created.remoteSessionId, { modelId: 'fixture-added-model' }),
    );
    assert.equal(selected.currentModelId, 'fixture-added-model');
    const confirmed = events.filter((event) => event.type === 'model.selection_changed').at(-1);
    assert.equal(confirmed.payload.modelId, 'fixture-added-model');
    assert.equal(confirmed.payload.confirmed, true);
    const afterSelect = await daemon.sessions.handleCommand(
      modelCommand('model.list', created.remoteSessionId, {}, 'req-model-list-2'),
    );
    assert.equal(afterSelect.currentModelId, 'fixture-added-model');
    assert.deepEqual(
      afterSelect.models.map((model) => model.id).includes('fixture-added-model'),
      true,
    );

    await assert.rejects(
      () =>
        daemon.sessions.handleCommand(
          modelCommand('model.select', created.remoteSessionId, { modelId: 'missing-model' }),
        ),
      /Unknown or unavailable model/,
    );
  });
});

test('model.select is rejected while a prompt is in progress', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(async (daemon) => {
    const events = collectEvents(daemon);
    const { created } = await createIdleSession(daemon, workspacePath);
    const sending = daemon.sessions.send(created.remoteSessionId, 'DELAY');
    await waitUntil(() =>
      events.some(
        (event) => event.type === 'assistant.status' && event.payload.status === 'thinking',
      ),
    );
    await assert.rejects(
      () =>
        daemon.sessions.handleCommand(
          modelCommand('model.select', created.remoteSessionId, { modelId: 'mock-fast' }),
        ),
      /prompt in progress/,
    );
    await daemon.sessions.cancel(created.remoteSessionId);
    await sending;
  });
});

test('TASK-402 usage_update correlates to the remote session and omits cost', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(async (daemon) => {
    const events = collectEvents(daemon);
    const { registered, created } = await createIdleSession(daemon, workspacePath);
    const other = await daemon.sessions.create({
      workspaceId: registered.workspaceId,
      initialPrompt: '',
      title: null,
    });
    await daemon.sessions.send(created.remoteSessionId, 'TASK-402');
    const updated = events.filter((event) => event.type === 'session.context_updated');
    assert.equal(updated.length, 1);
    assert.equal(updated[0].sessionId, created.remoteSessionId);
    assert.equal(
      updated.some((event) => event.sessionId === other.remoteSessionId),
      false,
    );
    assert.deepEqual(updated[0].payload, { used: 1234, size: 8000 });
    assert.equal(JSON.stringify(updated[0].payload).includes('cost'), false);
    assert.equal(JSON.stringify(updated[0].payload).includes('amount'), false);
    assert.equal(JSON.stringify(updated[0].payload).includes('currency'), false);
    const usageUpdated = events.filter((event) => event.type === 'session.usage_updated');
    assert.equal(usageUpdated.length, 1);
    assert.equal(usageUpdated[0].sessionId, created.remoteSessionId);
    assert.equal(
      usageUpdated.some((event) => event.sessionId === other.remoteSessionId),
      false,
    );
    assert.deepEqual(usageUpdated[0].payload, { cost: { amount: 0.25, currency: 'USD' } });
  });
});

function catchUpCommand(sessionId, lastEventId, requestId = 'req-catch-up') {
  return parseRemoteCommand(
    serializeCommand({
      requestId,
      sessionId,
      timestamp: new Date().toISOString(),
      type: 'sync.catch_up',
      payload: { lastEventId },
    }),
  );
}

test('catch-up replays after cursor, gaps on miss, and keeps session lastEventId', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(async (daemon) => {
    const events = [];
    daemon.onEvent((event) => events.push(event));
    const { created } = await createIdleSession(daemon, workspacePath);
    const head = events.at(-1).eventId;
    const empty = await daemon.handleCommand(catchUpCommand(created.remoteSessionId, null));
    assert.equal(empty.status, 'replayed');
    assert.deepEqual(empty.events, []);
    assert.equal(empty.headEventId, head);
    assert.equal(empty.pendingPermission, null);

    const atHead = await daemon.handleCommand(catchUpCommand(created.remoteSessionId, head));
    assert.equal(atHead.status, 'replayed');
    assert.deepEqual(atHead.events, []);

    const firstId = events[0].eventId;
    const afterFirst = await daemon.handleCommand(catchUpCommand(created.remoteSessionId, firstId));
    assert.equal(afterFirst.status, 'replayed');
    assert.deepEqual(
      afterFirst.events.map((event) => event.eventId),
      events.slice(1).map((event) => event.eventId),
    );

    const gap = await daemon.handleCommand(
      catchUpCommand(created.remoteSessionId, 'missing-cursor'),
    );
    assert.equal(gap.status, 'gap');
    assert.deepEqual(gap.events, []);
    assert.equal(gap.headEventId, head);

    const before = events.length;
    await daemon.sessions.send(created.remoteSessionId, 'hello');
    assert.ok(events.length > before);
    const afterSend = await daemon.handleCommand(catchUpCommand(created.remoteSessionId, head));
    assert.equal(afterSend.status, 'replayed');
    assert.ok(afterSend.events.some((event) => event.type === 'assistant.message'));
    assert.equal(afterSend.headEventId, events.at(-1).eventId);
    assert.equal(
      afterSend.events.some((event) => event.type === 'session.loaded'),
      false,
    );
  });
});

test('catch-up returns pending permission snapshot without session.load or prompt', async () => {
  const workspacePath = makeWorkspace();
  await withDaemon(async (daemon) => {
    const events = collectEvents(daemon);
    const { created } = await createIdleSession(daemon, workspacePath);
    const sending = daemon.sessions.send(created.remoteSessionId, 'ASK_PERMISSION');
    const requested = await waitForPermissionRequested(events);
    const loadedBefore = events.filter((event) => event.type === 'session.loaded').length;
    const catchUp = await daemon.handleCommand(catchUpCommand(created.remoteSessionId, null));
    assert.equal(catchUp.status, 'replayed');
    assert.deepEqual(catchUp.events, []);
    assert.deepEqual(catchUp.pendingPermission, {
      permissionId: requested.payload.permissionId,
      kind: requested.payload.kind,
      command: requested.payload.command,
      risk: 'high',
    });
    assert.equal(events.filter((event) => event.type === 'session.loaded').length, loadedBefore);
    const none = await daemon.handleCommand(catchUpCommand(null, catchUp.headEventId));
    assert.equal(none.pendingPermission, null);
    await daemon.sessions.handleCommand(
      permissionCommand(
        'permission.reject',
        created.remoteSessionId,
        requested.payload.permissionId,
      ),
    );
    await sending;
    const settled = await daemon.handleCommand(
      catchUpCommand(created.remoteSessionId, catchUp.headEventId),
    );
    assert.equal(settled.pendingPermission, null);
  });
});
