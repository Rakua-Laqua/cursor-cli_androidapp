import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PERMISSION_COMMAND_LENGTH,
  MAX_PERMISSION_KIND_LENGTH,
  PermissionBridge,
} from '../dist/index.js';

const OBSERVED_OPTIONS = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

function observedParams(overrides = {}) {
  return {
    sessionId: 'cursor-1',
    toolCall: {
      toolCallId: 'tool_perm_1',
      title: 'Get-ChildItem -Force',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'Get-ChildItem -Force' },
    },
    options: OBSERVED_OPTIONS,
    ...overrides,
  };
}

function createBridge(overrides = {}) {
  const requested = [];
  const resolved = [];
  const sessions = new Map([['cursor-1', 'remote-1']]);
  const bridge = new PermissionBridge({
    resolveRemoteSessionId: (cursorSessionId) => sessions.get(cursorSessionId),
    onRequested: (notice) => requested.push(notice),
    onResolved: (notice) => resolved.push(notice),
    timeoutMs: 60_000,
    createPermissionId: () => 'perm-fixed',
    ...overrides,
  });
  return { bridge, requested, resolved, sessions };
}

test('approve returns saved allow-once and never selects allow-always', async () => {
  const { bridge, requested, resolved } = createBridge();
  const waiting = bridge.handleRequestPermission(observedParams());
  assert.equal(requested.length, 1);
  assert.equal(requested[0].permissionId, 'perm-fixed');
  assert.equal(requested[0].kind, 'execute');
  assert.equal(requested[0].command, 'Get-ChildItem -Force');
  assert.equal(requested[0].risk, 'high');
  bridge.approve('remote-1', 'perm-fixed');
  assert.deepEqual(await waiting, {
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].decision, 'approved');
  assert.equal(JSON.stringify(await waiting).includes('allow-always'), false);
});

test('reject, timeout, and cancel return saved reject-once', async () => {
  const rejected = createBridge({ createPermissionId: () => 'perm-reject' });
  const rejecting = rejected.bridge.handleRequestPermission(observedParams());
  rejected.bridge.reject('remote-1', 'perm-reject');
  assert.deepEqual(await rejecting, {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  });
  assert.equal(rejected.resolved[0].decision, 'rejected');

  const timed = createBridge({ timeoutMs: 20, createPermissionId: () => 'perm-timeout' });
  const timing = timed.bridge.handleRequestPermission(observedParams());
  assert.deepEqual(await timing, {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  });
  assert.equal(timed.resolved[0].decision, 'rejected');
  assert.equal(timed.requested.length, 1);

  const cancelled = createBridge({ createPermissionId: () => 'perm-cancel' });
  const cancelling = cancelled.bridge.handleRequestPermission(observedParams());
  cancelled.bridge.rejectPendingForSession('remote-1');
  assert.deepEqual(await cancelling, {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  });
  assert.equal(cancelled.resolved[0].decision, 'rejected');
});

test('invalid, unknown session, and duplicate pending fail closed without waiting', async () => {
  const { bridge, requested } = createBridge();
  await assert.rejects(() => bridge.handleRequestPermission(null), /Invalid permission request/);
  await assert.rejects(() => bridge.handleRequestPermission({}), /Invalid permission request/);
  assert.deepEqual(
    await bridge.handleRequestPermission(
      observedParams({ sessionId: 'missing', options: OBSERVED_OPTIONS }),
    ),
    { outcome: { outcome: 'selected', optionId: 'reject-once' } },
  );
  assert.deepEqual(
    await bridge.handleRequestPermission(
      observedParams({
        options: [{ optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }],
      }),
    ),
    { outcome: { outcome: 'selected', optionId: 'reject-once' } },
  );
  assert.deepEqual(
    await bridge.handleRequestPermission(
      observedParams({ toolCall: 'nope', options: OBSERVED_OPTIONS }),
    ),
    { outcome: { outcome: 'selected', optionId: 'reject-once' } },
  );

  const waiting = bridge.handleRequestPermission(observedParams());
  assert.equal(requested.length, 1);
  assert.deepEqual(await bridge.handleRequestPermission(observedParams()), {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  });
  assert.equal(requested.length, 1);
  bridge.rejectAllPending();
  assert.deepEqual(await waiting, {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  });
});

test('unknown permission, session mismatch, and double decision fail the command without a second ACP outcome', async () => {
  const { bridge, resolved } = createBridge();
  const waiting = bridge.handleRequestPermission(observedParams());
  assert.throws(() => bridge.approve('remote-other', 'perm-fixed'), /Permission session mismatch/);
  assert.throws(() => bridge.approve('remote-1', 'perm-missing'), /Unknown permission/);
  assert.equal(resolved.length, 0);
  bridge.approve('remote-1', 'perm-fixed');
  assert.deepEqual(await waiting, {
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  });
  assert.equal(resolved.length, 1);
  assert.throws(() => bridge.reject('remote-1', 'perm-fixed'), /Permission already decided/);
  assert.equal(resolved.length, 1);
});

test('display kind and command are length-limited and risk is always high', async () => {
  const { bridge, requested } = createBridge();
  const kind = 'k'.repeat(MAX_PERMISSION_KIND_LENGTH + 8);
  const command = 'c'.repeat(MAX_PERMISSION_COMMAND_LENGTH + 8);
  const waiting = bridge.handleRequestPermission(
    observedParams({
      toolCall: {
        toolCallId: 'tool_long',
        title: command,
        kind,
        rawInput: { command: 'ignored-when-title-present' },
      },
    }),
  );
  assert.equal(requested[0].kind, 'k'.repeat(MAX_PERMISSION_KIND_LENGTH));
  assert.equal(requested[0].command, 'c'.repeat(MAX_PERMISSION_COMMAND_LENGTH));
  assert.equal(requested[0].risk, 'high');
  bridge.rejectAllPending();
  await waiting;
});

test('permission wait requires a running session and otherwise reject-once', async () => {
  const statuses = new Map([['cursor-1', 'idle']]);
  const { bridge, requested } = createBridge({
    resolveRemoteSessionId: (cursorSessionId) =>
      statuses.get(cursorSessionId) === 'running' ? 'remote-1' : undefined,
  });
  assert.deepEqual(await bridge.handleRequestPermission(observedParams()), {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  });
  assert.equal(requested.length, 0);
  statuses.set('cursor-1', 'completed');
  assert.deepEqual(await bridge.handleRequestPermission(observedParams()), {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  });
  assert.equal(requested.length, 0);
  statuses.set('cursor-1', 'running');
  const waiting = bridge.handleRequestPermission(observedParams());
  assert.equal(requested.length, 1);
  bridge.rejectAllPending();
  await waiting;
});
