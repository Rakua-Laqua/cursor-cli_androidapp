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
