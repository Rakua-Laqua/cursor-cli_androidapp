import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AcpJsonRpcError, AcpProcessExitedError, Daemon } from '../dist/index.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-acp.mjs');

function mockLaunch() {
  return {
    command: process.execPath,
    args: [fixture],
  };
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withDaemon(options, fn) {
  const { logger, ...acp } = options;
  const daemon = await Daemon.start({
    logger,
    acp: {
      ...mockLaunch(),
      shutdownTimeoutMs: 1000,
      ...acp,
    },
  });
  try {
    await fn(daemon);
  } finally {
    await daemon.stop();
  }
}

test('daemon start can talk JSON-RPC initialize to ACP', async () => {
  await withDaemon({}, async (daemon) => {
    assert.equal(typeof daemon.acp.pid, 'number');
    assert.equal(daemon.acp.getState(), 'running');
    const result = await daemon.acp.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'daemon-test', version: '0.0.0' },
    });
    assert.equal(result.protocolVersion, 1);
    assert.equal(result.agentCapabilities.loadSession, true);
  });
});

test('request and response preserve the JSON-RPC id pairing', async () => {
  await withDaemon({}, async (daemon) => {
    const first = daemon.acp.request('echo', { n: 1 });
    const second = daemon.acp.request('echo', { n: 2 });
    assert.deepEqual(await first, { params: { n: 1 } });
    assert.deepEqual(await second, { params: { n: 2 } });
  });
});

test('notifications are delivered without completing a request', async () => {
  await withDaemon({}, async (daemon) => {
    const seen = [];
    daemon.acp.onNotification((notification) => seen.push(notification));
    await daemon.acp.request('notify-me');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'session/update');
    assert.equal(seen[0].params.update.sessionUpdate, 'agent_message_chunk');
  });
});

test('unknown incoming ACP request is answered so the agent does not block', async () => {
  await withDaemon({}, async (daemon) => {
    const result = await daemon.acp.request('peer-request');
    assert.equal(result.peerId, 'peer-1');
    assert.equal(result.error.code, -32601);
    assert.match(result.error.message, /session\/request_permission/);
  });
});

test('incoming request handler result is sent back to ACP', async () => {
  await withDaemon(
    {
      onIncomingRequest(request) {
        assert.equal(request.method, 'session/request_permission');
        return { outcome: { outcome: 'selected', optionId: 'reject-once' } };
      },
    },
    async (daemon) => {
      const result = await daemon.acp.request('peer-request');
      assert.deepEqual(result.result, {
        outcome: { outcome: 'selected', optionId: 'reject-once' },
      });
      assert.equal(result.error, null);
    },
  );
});

test('ACP crash rejects pending requests and does not take down the daemon', async () => {
  const daemon = await Daemon.start({
    acp: {
      ...mockLaunch(),
      shutdownTimeoutMs: 1000,
    },
  });
  const exits = [];
  daemon.acp.onExit((info) => exits.push(info));
  const pending = daemon.acp.request('hang');
  await daemon.acp.request('crash').catch(() => {});
  await assert.rejects(pending, AcpProcessExitedError);
  assert.equal(daemon.acp.getState(), 'exited');
  assert.equal(exits[0]?.expected, false);
  assert.equal(exits[0]?.code, 2);
  await daemon.stop();
});

test('JSON-RPC error responses become AcpJsonRpcError', async () => {
  await withDaemon({}, async (daemon) => {
    await assert.rejects(
      () => daemon.acp.request('missing-method'),
      (error) => {
        assert.ok(error instanceof AcpJsonRpcError);
        assert.equal(error.code, -32601);
        return true;
      },
    );
  });
});

test('invalid stdout lines are ignored and later responses still work', async () => {
  await withDaemon({}, async (daemon) => {
    const result = await daemon.acp.request('emit-garbage');
    assert.deepEqual(result, { ok: true });
  });
});

test('stderr lines are forwarded to the logger', async () => {
  const stderr = [];
  await withDaemon(
    {
      logger: {
        info() {},
        error(message) {
          stderr.push(message);
        },
      },
    },
    async (daemon) => {
      await daemon.acp.request('stderr-line');
    },
  );
  assert.ok(stderr.includes('stderr-line'));
});

test('timed out requests are cleaned up from the pending map', async () => {
  await withDaemon({ requestTimeoutMs: 50 }, async (daemon) => {
    await assert.rejects(() => daemon.acp.request('hang'), /timed out/);
    const result = await daemon.acp.request('echo', { ok: true });
    assert.deepEqual(result, { params: { ok: true } });
  });
});

test('daemon stop leaves no ACP child process', async () => {
  const daemon = await Daemon.start({
    acp: {
      ...mockLaunch(),
      shutdownTimeoutMs: 1000,
    },
  });
  const pid = daemon.acp.pid;
  assert.equal(typeof pid, 'number');
  assert.equal(pidExists(pid), true);
  await daemon.stop();
  assert.equal(daemon.acp.getState(), 'exited');
  assert.equal(pidExists(pid), false);
});

test('notify writes a JSON-RPC notification without throwing', async () => {
  await withDaemon({}, async (daemon) => {
    daemon.acp.notify('session/cancel', { sessionId: 's' });
    const result = await daemon.acp.request('echo', { after: 'notify' });
    assert.deepEqual(result, { params: { after: 'notify' } });
  });
});
