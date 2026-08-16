import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseRemoteCommand,
  parseRemoteEvent,
  serializeCommand,
  serializeEvent,
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
