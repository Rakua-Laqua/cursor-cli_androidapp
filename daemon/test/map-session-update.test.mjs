import assert from 'node:assert/strict';
import test from 'node:test';

import { mapAcpSessionUpdate } from '../dist/index.js';

test('user_message_chunk maps to user.message', () => {
  assert.deepEqual(
    mapAcpSessionUpdate({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'hi' },
    }),
    [{ type: 'user.message', payload: { text: 'hi' } }],
  );
});

test('agent_message_chunk maps to assistant.message with delta', () => {
  assert.deepEqual(
    mapAcpSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hel' },
    }),
    [{ type: 'assistant.message', payload: { text: 'Hel', delta: true } }],
  );
});

test('agent_thought_chunk maps to assistant.status thinking', () => {
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'agent_thought_chunk' }), [
    { type: 'assistant.status', payload: { status: 'thinking' } },
  ]);
});

test('unknown or incomplete updates map to an empty list', () => {
  assert.deepEqual(mapAcpSessionUpdate(undefined), []);
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'tool_call' }), []);
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'agent_message_chunk' }), []);
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'user_message_chunk', content: {} }), []);
});

test('usage_update maps to session.context_updated with used and size only', () => {
  assert.deepEqual(
    mapAcpSessionUpdate({
      sessionUpdate: 'usage_update',
      used: 10,
      size: 100,
      cost: 1.5,
      extra: true,
    }),
    [{ type: 'session.context_updated', payload: { used: 10, size: 100 } }],
  );
});

test('malformed usage_update emits no event', () => {
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'usage_update' }), []);
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: 1 }), []);
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'usage_update', size: 1 }), []);
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: '1', size: 1 }), []);
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: 1, size: '1' }), []);
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: true, size: 1 }), []);
  assert.deepEqual(
    mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: false, size: 1 }),
    [],
  );
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: null, size: 1 }), []);
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: 1, size: null }), []);
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: -1, size: 1 }), []);
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: 1, size: -1 }), []);
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: 1.5, size: 1 }), []);
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: 1, size: 1.5 }), []);
  assert.deepEqual(
    mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: Number.NaN, size: 1 }),
    [],
  );
  assert.deepEqual(
    mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: Number.POSITIVE_INFINITY, size: 1 }),
    [],
  );
  assert.deepEqual(
    mapAcpSessionUpdate({
      sessionUpdate: 'usage_update',
      used: Number.MAX_SAFE_INTEGER + 1,
      size: 1,
    }),
    [],
  );
  assert.deepEqual(
    mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: 1, size: Number.POSITIVE_INFINITY }),
    [],
  );
  assert.deepEqual(
    mapAcpSessionUpdate({
      sessionUpdate: 'usage_update',
      used: 1,
      size: Number.MAX_SAFE_INTEGER + 1,
    }),
    [],
  );
  assert.deepEqual(
    mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: { nested: 1 }, size: 1 }),
    [],
  );
  assert.deepEqual(
    mapAcpSessionUpdate({
      sessionUpdate: 'usage_update',
      tokens: { used: 1, size: 1 },
    }),
    [],
  );
});

test('usage_update accepts zero and MAX_SAFE_INTEGER bounds', () => {
  assert.deepEqual(mapAcpSessionUpdate({ sessionUpdate: 'usage_update', used: 0, size: 0 }), [
    { type: 'session.context_updated', payload: { used: 0, size: 0 } },
  ]);
  assert.deepEqual(
    mapAcpSessionUpdate({
      sessionUpdate: 'usage_update',
      used: Number.MAX_SAFE_INTEGER,
      size: Number.MAX_SAFE_INTEGER,
    }),
    [
      {
        type: 'session.context_updated',
        payload: { used: Number.MAX_SAFE_INTEGER, size: Number.MAX_SAFE_INTEGER },
      },
    ],
  );
});
