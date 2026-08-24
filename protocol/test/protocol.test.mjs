import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseRemoteCommand,
  parseRemoteCommandResult,
  parseRemoteEvent,
  parseRemoteFrame,
  remoteCommandFailure,
  remoteCommandSuccess,
  serializeCommand,
  serializeEvent,
  serializeRemoteCommandResult,
  serializeRemoteFrame,
} from '../dist/index.js';

test('known event serializes and deserializes without losing the envelope', () => {
  const event = {
    eventId: 'evt_001',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-17T07:00:00+09:00',
    type: 'assistant.message',
    payload: {
      text: 'hello',
      delta: true,
    },
  };

  assert.deepEqual(parseRemoteEvent(serializeEvent(event)), event);
});

test('command serializes and deserializes with a unique request id field', () => {
  const command = {
    requestId: 'req_001',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-17T07:00:01+09:00',
    type: 'session.send',
    payload: {
      text: 'continue',
    },
  };

  assert.deepEqual(parseRemoteCommand(serializeCommand(command)), command);
});

test('unknown event type is retained instead of crashing the receiver', () => {
  const parsed = parseRemoteEvent(
    JSON.stringify({
      eventId: 'evt_future',
      sessionId: null,
      timestamp: '2026-08-17T07:00:02+09:00',
      type: 'future.event',
      payload: {
        nested: ['still', 'valid'],
      },
    }),
  );

  assert.equal(parsed.type, 'future.event');
  assert.equal(parsed.knownType, false);
  assert.deepEqual(parsed.payload, { nested: ['still', 'valid'] });
});

test('invalid event envelope fails at the protocol boundary', () => {
  assert.throws(
    () =>
      parseRemoteEvent(
        JSON.stringify({
          eventId: '',
          sessionId: null,
          timestamp: '2026-08-17T07:00:02+09:00',
          type: 'assistant.status',
          payload: {},
        }),
      ),
    /eventId/,
  );
});

test('command frame roundtrips without changing command semantics', () => {
  const command = {
    requestId: 'req_frame',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-17T07:00:03+09:00',
    type: 'workspace.list',
    payload: {},
  };
  const parsed = parseRemoteFrame(serializeRemoteFrame({ kind: 'command', command }));
  assert.equal(parsed.kind, 'command');
  assert.deepEqual(parsed.command, command);
  assert.deepEqual(parseRemoteCommand(serializeCommand(command)), command);
});

test('event frame roundtrips through the existing event envelope', () => {
  const event = {
    eventId: 'evt_frame',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-17T07:00:04+09:00',
    type: 'assistant.message',
    payload: {
      text: 'chunk',
      delta: true,
    },
  };
  const parsed = parseRemoteFrame(serializeRemoteFrame({ kind: 'event', event }));
  assert.equal(parsed.kind, 'event');
  assert.deepEqual(parsed.event, event);
  assert.deepEqual(parseRemoteEvent(serializeEvent(event)), event);
});

test('successful undefined daemon result is encoded as JSON null', () => {
  const result = remoteCommandSuccess('req_undef', undefined);
  assert.equal(result.ok, true);
  assert.equal(result.value, null);
  assert.equal(result.error, null);
  const parsed = parseRemoteFrame(serializeRemoteFrame({ kind: 'result', result }));
  assert.equal(parsed.kind, 'result');
  assert.equal(parsed.result.value, null);
  assert.deepEqual(parseRemoteCommandResult(serializeRemoteCommandResult(result)), result);
});

test('error result sanitizes messages and drops stack traces', () => {
  const error = new Error('machine offline');
  error.stack = 'Error: machine offline\n    at RelayRouter.ts:10:1\n    at Module.job:2:1';
  const result = remoteCommandFailure('req_err', error);
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.equal(result.error, 'machine offline');
  const json = serializeRemoteCommandResult({
    requestId: 'req_err',
    ok: false,
    value: null,
    error: `${error.message}\n${error.stack}`,
  });
  assert.equal(json.includes('RelayRouter'), false);
  assert.equal(json.includes('\\n'), false);
  assert.deepEqual(parseRemoteCommandResult(json), result);
});

test('permission event and command payloads roundtrip without changing envelope semantics', () => {
  const requested = {
    eventId: 'evt_perm_req',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-17T07:00:05+09:00',
    type: 'permission.requested',
    payload: {
      permissionId: 'perm_001',
      kind: 'execute',
      command: 'Get-ChildItem -Force',
      risk: 'high',
    },
  };
  const resolved = {
    eventId: 'evt_perm_res',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-17T07:00:06+09:00',
    type: 'permission.resolved',
    payload: {
      permissionId: 'perm_001',
      decision: 'approved',
    },
  };
  const approve = {
    requestId: 'req_perm_approve',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-17T07:00:07+09:00',
    type: 'permission.approve',
    payload: {
      permissionId: 'perm_001',
    },
  };
  const reject = {
    requestId: 'req_perm_reject',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-17T07:00:08+09:00',
    type: 'permission.reject',
    payload: {
      permissionId: 'perm_001',
    },
  };

  assert.deepEqual(parseRemoteEvent(serializeEvent(requested)), requested);
  assert.deepEqual(parseRemoteEvent(serializeEvent(resolved)), resolved);
  assert.deepEqual(parseRemoteCommand(serializeCommand(approve)), approve);
  assert.deepEqual(parseRemoteCommand(serializeCommand(reject)), reject);
  assert.equal(JSON.stringify(approve.payload).includes('optionId'), false);
  assert.equal(JSON.stringify(approve.payload).includes('allow'), false);
  assert.equal(JSON.stringify(reject.payload).includes('risk'), false);
  assert.equal(JSON.stringify(reject.payload).includes('policy'), false);
  const requestedFrame = parseRemoteFrame(
    serializeRemoteFrame({ kind: 'event', event: requested }),
  );
  assert.equal(requestedFrame.kind, 'event');
  assert.deepEqual(requestedFrame.event, requested);
});

test('parseRemoteCommandResult rejects inconsistent ok, error, and value states', () => {
  assert.throws(
    () =>
      parseRemoteCommandResult(
        JSON.stringify({
          requestId: 'req_bad_ok',
          ok: true,
          value: null,
          error: 'should not be set',
        }),
      ),
    /error null/,
  );
  assert.throws(
    () =>
      parseRemoteCommandResult(
        JSON.stringify({
          requestId: 'req_bad_fail',
          ok: false,
          value: null,
          error: null,
        }),
      ),
    /non-empty error/,
  );
  assert.throws(
    () =>
      parseRemoteCommandResult(
        JSON.stringify({
          requestId: 'req_bad_value',
          ok: false,
          value: { leaked: true },
          error: 'nope',
        }),
      ),
    /value null/,
  );
  const success = remoteCommandSuccess('req_ok', { listed: true });
  const failure = remoteCommandFailure('req_fail', new Error('offline'));
  assert.deepEqual(parseRemoteCommandResult(JSON.stringify(success)), success);
  assert.deepEqual(parseRemoteCommandResult(JSON.stringify(failure)), failure);
});

test('diff.read command and diff.updated event payloads roundtrip', () => {
  const snapshot = {
    workspaceId: 'ws-diff',
    available: true,
    source: 'git',
    files: [
      {
        path: 'src/foo.ts',
        previousPath: null,
        change: 'modified',
        binary: false,
        sensitive: false,
        additions: 2,
        deletions: 1,
        unifiedDiff: '--- a/src/foo.ts\n+++ b/src/foo.ts\n',
        truncated: false,
      },
      {
        path: 'src/renamed.ts',
        previousPath: 'src/old.ts',
        change: 'renamed',
        binary: false,
        sensitive: false,
        additions: 0,
        deletions: 0,
        unifiedDiff: null,
        truncated: false,
      },
    ],
    truncated: false,
    omittedCount: 0,
    totalAdditions: 2,
    totalDeletions: 1,
  };
  const event = {
    eventId: 'evt_diff',
    sessionId: null,
    timestamp: '2026-08-22T00:00:00+09:00',
    type: 'diff.updated',
    payload: snapshot,
  };
  const command = {
    requestId: 'req_diff',
    sessionId: null,
    timestamp: '2026-08-22T00:00:01+09:00',
    type: 'diff.read',
    payload: {
      workspaceId: 'ws-diff',
    },
  };

  assert.deepEqual(parseRemoteEvent(serializeEvent(event)), event);
  assert.deepEqual(parseRemoteCommand(serializeCommand(command)), command);
  const eventFrame = parseRemoteFrame(serializeRemoteFrame({ kind: 'event', event }));
  assert.equal(eventFrame.kind, 'event');
  assert.deepEqual(eventFrame.event, event);
  const commandFrame = parseRemoteFrame(serializeRemoteFrame({ kind: 'command', command }));
  assert.equal(commandFrame.kind, 'command');
  assert.deepEqual(commandFrame.command, command);
  assert.equal(command.sessionId, null);
  assert.deepEqual(command.payload, { workspaceId: 'ws-diff' });
  assert.equal(JSON.stringify(command.payload).includes('path'), false);
  assert.equal(JSON.stringify(command.payload).includes('git'), false);
});

test('file.read command and file content success value roundtrip without file events', () => {
  const command = {
    requestId: 'req_file',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-22T00:00:02+09:00',
    type: 'file.read',
    payload: {
      path: 'src/foo.ts',
    },
  };
  const success = remoteCommandSuccess('req_file', {
    path: 'src/foo.ts',
    content: 'export const n = 1;\n',
    truncated: false,
  });

  assert.deepEqual(parseRemoteCommand(serializeCommand(command)), command);
  const commandFrame = parseRemoteFrame(serializeRemoteFrame({ kind: 'command', command }));
  assert.equal(commandFrame.kind, 'command');
  assert.deepEqual(commandFrame.command, command);
  assert.equal(command.sessionId, 'remote_sess_123');
  assert.deepEqual(command.payload, { path: 'src/foo.ts' });
  assert.equal(JSON.stringify(command.payload).includes('workspaceId'), false);
  assert.equal(JSON.stringify(command.payload).includes('startLine'), false);
  assert.equal(JSON.stringify(command.payload).includes('endLine'), false);
  assert.deepEqual(parseRemoteCommandResult(serializeRemoteCommandResult(success)), success);
  assert.equal(success.ok, true);
  assert.equal(success.value.path, 'src/foo.ts');
  assert.equal(success.value.content, 'export const n = 1;\n');
  assert.equal(success.value.truncated, false);
  assert.equal(JSON.stringify(success).includes('file.reference'), false);
  assert.equal(JSON.stringify(success).includes('file.content'), false);
});

test('model.list, model.select, catalog, and selection payloads roundtrip without hardcoded models', () => {
  const catalog = {
    models: [
      {
        id: 'fixture-added-model',
        displayName: 'Fixture Added',
        description: 'Provided by catalog fixture',
        parameters: [],
        variants: [],
        available: true,
      },
      {
        id: 'id-only-model',
        displayName: 'id-only-model',
        description: null,
        parameters: [],
        variants: [],
        available: true,
      },
    ],
    currentModelId: 'fixture-added-model',
  };
  const catalogEvent = {
    eventId: 'evt_catalog',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-23T00:00:00+09:00',
    type: 'model.catalog_updated',
    payload: catalog,
  };
  const selectionEvent = {
    eventId: 'evt_selection',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-23T00:00:01+09:00',
    type: 'model.selection_changed',
    payload: {
      modelId: 'fixture-added-model',
      confirmed: true,
    },
  };
  const listCommand = {
    requestId: 'req_model_list',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-23T00:00:02+09:00',
    type: 'model.list',
    payload: {},
  };
  const selectCommand = {
    requestId: 'req_model_select',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-23T00:00:03+09:00',
    type: 'model.select',
    payload: {
      modelId: 'fixture-added-model',
    },
  };
  const success = remoteCommandSuccess('req_model_list', catalog);

  assert.deepEqual(parseRemoteEvent(serializeEvent(catalogEvent)), catalogEvent);
  assert.deepEqual(parseRemoteEvent(serializeEvent(selectionEvent)), selectionEvent);
  assert.deepEqual(parseRemoteCommand(serializeCommand(listCommand)), listCommand);
  assert.deepEqual(parseRemoteCommand(serializeCommand(selectCommand)), selectCommand);
  assert.deepEqual(parseRemoteCommandResult(serializeRemoteCommandResult(success)), success);
  const catalogFrame = parseRemoteFrame(
    serializeRemoteFrame({ kind: 'event', event: catalogEvent }),
  );
  assert.equal(catalogFrame.kind, 'event');
  assert.deepEqual(catalogFrame.event, catalogEvent);
  const selectFrame = parseRemoteFrame(
    serializeRemoteFrame({ kind: 'command', command: selectCommand }),
  );
  assert.equal(selectFrame.kind, 'command');
  assert.deepEqual(selectFrame.command, selectCommand);
  assert.equal(selectCommand.sessionId, 'remote_sess_123');
  assert.deepEqual(selectCommand.payload, { modelId: 'fixture-added-model' });
  assert.equal(JSON.stringify(selectCommand.payload).includes('gpt'), false);
  assert.equal(JSON.stringify(catalog).includes('cursor-grok'), false);
});

test('session.context_updated payload roundtrips with used and size only', () => {
  const event = {
    eventId: 'evt_context',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-23T00:00:04+09:00',
    type: 'session.context_updated',
    payload: {
      used: 12,
      size: 100,
    },
  };

  assert.deepEqual(parseRemoteEvent(serializeEvent(event)), event);
  const eventFrame = parseRemoteFrame(serializeRemoteFrame({ kind: 'event', event }));
  assert.equal(eventFrame.kind, 'event');
  assert.deepEqual(eventFrame.event, event);
  assert.deepEqual(event.payload, { used: 12, size: 100 });
  assert.equal(JSON.stringify(event.payload).includes('cost'), false);
  assert.equal(JSON.stringify(event).includes('session.context.get'), false);
});

test('session.context_breakdown_updated payload roundtrips with categories', () => {
  const event = {
    eventId: 'evt_context_breakdown',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-23T00:00:05+09:00',
    type: 'session.context_breakdown_updated',
    payload: {
      categories: [
        { id: 'system_prompt', displayName: 'System prompt', tokens: 5000 },
        { id: 'conversation', displayName: 'Conversation', tokens: 12 },
      ],
    },
  };

  assert.deepEqual(parseRemoteEvent(serializeEvent(event)), event);
  const eventFrame = parseRemoteFrame(serializeRemoteFrame({ kind: 'event', event }));
  assert.equal(eventFrame.kind, 'event');
  assert.deepEqual(eventFrame.event, event);
  assert.deepEqual(event.payload.categories, [
    { id: 'system_prompt', displayName: 'System prompt', tokens: 5000 },
    { id: 'conversation', displayName: 'Conversation', tokens: 12 },
  ]);
});

test('session.usage_updated payload roundtrips with nested cost only', () => {
  const event = {
    eventId: 'evt_usage',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-24T00:00:07+09:00',
    type: 'session.usage_updated',
    payload: {
      cost: {
        amount: 0.045,
        currency: 'USD',
      },
    },
  };

  assert.deepEqual(parseRemoteEvent(serializeEvent(event)), event);
  const eventFrame = parseRemoteFrame(serializeRemoteFrame({ kind: 'event', event }));
  assert.equal(eventFrame.kind, 'event');
  assert.deepEqual(eventFrame.event, event);
  assert.deepEqual(event.payload, { cost: { amount: 0.045, currency: 'USD' } });
  assert.equal(JSON.stringify(event.payload).includes('inputTokens'), false);
  assert.equal(JSON.stringify(event.payload).includes('totalTokens'), false);
});
