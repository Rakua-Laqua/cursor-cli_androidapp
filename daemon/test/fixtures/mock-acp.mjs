import readline from 'node:readline';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendUpdate(sessionId, update) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update },
  });
}

function sessionMeta() {
  return {
    modes: {
      currentModeId: 'agent',
      availableModes: [{ id: 'agent', name: 'Agent' }],
    },
    models: {
      currentModelId: 'mock-model',
      availableModels: [{ id: 'mock-model', name: 'Mock' }],
    },
    configOptions: [],
  };
}

function readPromptText(params) {
  const prompt = params?.prompt;
  if (!Array.isArray(prompt) || prompt.length === 0) {
    return '';
  }
  const first = prompt[0];
  return first && typeof first.text === 'string' ? first.text : '';
}

function waitForCancel(sessionId, timeoutMs) {
  if (pendingCancels.has(sessionId)) {
    pendingCancels.delete(sessionId);
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      delayWaiters.delete(sessionId);
      resolve(false);
    }, timeoutMs);
    delayWaiters.set(sessionId, () => {
      clearTimeout(timer);
      delayWaiters.delete(sessionId);
      pendingCancels.delete(sessionId);
      resolve(true);
    });
  });
}

async function handlePrompt(id, params) {
  const sessionId = params?.sessionId;
  if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: 'Unknown session' },
    });
    return;
  }

  const text = readPromptText(params);
  sendUpdate(sessionId, {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text },
  });
  sendUpdate(sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking' },
  });

  if (text === 'DELAY') {
    const cancelled = await waitForCancel(sessionId, 8000);
    send({
      jsonrpc: '2.0',
      id,
      result: { stopReason: cancelled ? 'cancelled' : 'end_turn' },
    });
    return;
  }

  const reply = `echo:${text}`;
  const splitAt = Math.max(1, Math.ceil(reply.length / 2));
  sendUpdate(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: reply.slice(0, splitAt) },
  });
  sendUpdate(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: reply.slice(splitAt) },
  });
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
}

const pendingPeer = new Map();
const sessions = new Set();
const pendingCancels = new Set();
const delayWaiters = new Map();
let sessionSeq = 0;
let initializeCount = 0;
let authenticateCount = 0;
let initializeFailRemaining = Number.parseInt(process.env.MOCK_ACP_FAIL_INITIALIZE ?? '0', 10);
if (!Number.isFinite(initializeFailRemaining) || initializeFailRemaining < 0) {
  initializeFailRemaining = 0;
}
const ignoreStdin = process.env.MOCK_ACP_IGNORE_STDIN === '1';
const ignoreSigterm = process.env.MOCK_ACP_IGNORE_SIGTERM === '1';

process.stderr.write('mock-acp-started\n');

if (ignoreSigterm) {
  process.on('SIGTERM', () => {
    process.stderr.write('mock-acp-ignored-sigterm\n');
  });
}

const rl = readline.createInterface({ input: process.stdin });

if (!ignoreStdin) {
  rl.on('close', () => {
    process.exit(0);
  });
}

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
    initializeCount += 1;
    if (initializeFailRemaining > 0) {
      initializeFailRemaining -= 1;
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: 'initialize failed' },
      });
      return;
    }
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

  if (method === 'authenticate') {
    authenticateCount += 1;
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'debug-stats') {
    send({
      jsonrpc: '2.0',
      id,
      result: { initializeCount, authenticateCount },
    });
    return;
  }

  if (method === 'session/new') {
    sessionSeq += 1;
    const sessionId = `sess-${sessionSeq}`;
    sessions.add(sessionId);
    send({
      jsonrpc: '2.0',
      id,
      result: {
        sessionId,
        ...sessionMeta(),
      },
    });
    return;
  }

  if (method === 'session/load') {
    const sessionId = params?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Unknown session' },
      });
      return;
    }
    sessions.add(sessionId);
    send({ jsonrpc: '2.0', id, result: sessionMeta() });
    return;
  }

  if (method === 'session/prompt') {
    void handlePrompt(id, params);
    return;
  }

  if (method === 'session/cancel') {
    if (typeof id !== 'undefined') {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found: session/cancel' },
      });
      return;
    }
    const sessionId = params?.sessionId;
    if (typeof sessionId === 'string') {
      pendingCancels.add(sessionId);
      const resume = delayWaiters.get(sessionId);
      if (resume) {
        resume();
      }
    }
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
