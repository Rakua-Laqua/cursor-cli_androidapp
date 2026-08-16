import readline from 'node:readline';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const pendingPeer = new Map();

process.stderr.write('mock-acp-started\n');

const rl = readline.createInterface({ input: process.stdin });

rl.on('close', () => {
  process.exit(0);
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stderr.write('mock-acp-bad-json\n');
    return;
  }

  if (message && Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
    const waiter = pendingPeer.get(message.id);
    if (waiter) {
      pendingPeer.delete(message.id);
      waiter(message);
    }
    return;
  }

  const { id, method, params } = message ?? {};

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
        },
      },
    });
    return;
  }

  if (method === 'echo') {
    send({ jsonrpc: '2.0', id, result: { params } });
    return;
  }

  if (method === 'notify-me') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's',
        update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } },
      },
    });
    send({ jsonrpc: '2.0', id, result: { ok: true } });
    return;
  }

  if (method === 'peer-request') {
    const peerId = 'peer-1';
    send({
      jsonrpc: '2.0',
      id: peerId,
      method: 'session/request_permission',
      params: { sessionId: 's', toolCall: { toolCallId: 'tool_1' }, options: [] },
    });
    pendingPeer.set(peerId, (response) => {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          peerId,
          error: response.error ?? null,
          result: response.result ?? null,
        },
      });
    });
    return;
  }

  if (method === 'crash') {
    process.exit(2);
    return;
  }

  if (method === 'hang') {
    return;
  }

  if (method === 'emit-garbage') {
    process.stdout.write('not-json\n');
    send({ jsonrpc: '2.0', id, result: { ok: true } });
    return;
  }

  if (method === 'stderr-line') {
    process.stderr.write('stderr-line\n');
    send({ jsonrpc: '2.0', id, result: { ok: true } });
    return;
  }

  if (typeof id !== 'undefined') {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
});
