import assert from 'node:assert/strict';
import test from 'node:test';

import { NdjsonBuffer, parseJsonRpcLine } from '../dist/index.js';

test('NdjsonBuffer splits newline-delimited messages and keeps a partial line', () => {
  const buffer = new NdjsonBuffer();
  assert.deepEqual(buffer.push('{"a":1}\n{"b":'), ['{"a":1}']);
  assert.deepEqual(buffer.push('2}\r\n'), ['{"b":2}']);
});

test('parseJsonRpcLine classifies request, notification, success, and error', () => {
  assert.deepEqual(parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'), {
    kind: 'request',
    id: 1,
    method: 'initialize',
    params: {},
  });
  assert.deepEqual(
    parseJsonRpcLine('{"jsonrpc":"2.0","method":"session/update","params":{"x":1}}'),
    {
      kind: 'notification',
      method: 'session/update',
      params: { x: 1 },
    },
  );
  assert.deepEqual(parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'), {
    kind: 'success',
    id: 1,
    result: { ok: true },
  });
  assert.equal(
    parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"nope"}}').kind,
    'error',
  );
});

test('invalid JSON does not throw', () => {
  const parsed = parseJsonRpcLine('{');
  assert.equal(parsed.kind, 'invalid');
});
