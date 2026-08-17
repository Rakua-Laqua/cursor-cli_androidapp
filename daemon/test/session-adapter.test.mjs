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
