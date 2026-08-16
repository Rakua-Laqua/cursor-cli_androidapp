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
