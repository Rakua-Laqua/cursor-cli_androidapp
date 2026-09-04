import fs from 'node:fs';
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

function fixtureModels() {
  return [
    { id: 'mock-model', name: 'Mock' },
    { id: 'mock-fast', name: 'Mock Fast', description: 'Faster mock' },
    { id: 'fixture-added-model' },
  ];
}

function sessionMeta(currentModelId = 'mock-model') {
  return {
    modes: {
      currentModeId: 'agent',
      availableModes: [{ id: 'agent', name: 'Agent' }],
    },
    models: {
      currentModelId,
      availableModels: fixtureModels(),
    },
    configOptions: [
      { id: 'mode', category: 'mode', type: 'select', currentValue: 'agent' },
      { id: 'model', category: 'model', type: 'select', currentValue: currentModelId },
    ],
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

  if (text === 'TASK-402') {
    sendUpdate(sessionId, {
      sessionUpdate: 'usage_update',
      used: 1234,
      size: 8000,
      cost: { amount: 0.25, currency: 'USD' },
    });
  }

  if (text === 'ASK_PERMISSION') {
    const permission = await requestObservedPermission(sessionId);
    if (permission.cancelled || pendingCancels.has(sessionId)) {
      send({
        jsonrpc: '2.0',
        id,
        result: { stopReason: 'cancelled' },
      });
      return;
    }
    const optionId =
      typeof permission.optionId === 'string' && permission.optionId.length > 0
        ? permission.optionId
        : 'none';
    const reply = `echo:${text}:${optionId}`;
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
    return;
  }

  const cancelled = await waitForCancel(sessionId, text === 'DELAY' ? 8000 : 250);
  if (cancelled) {
    send({
      jsonrpc: '2.0',
      id,
      result: { stopReason: 'cancelled' },
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

function requestObservedPermission(sessionId) {
  return new Promise((resolve) => {
    const peerId = `perm-${sessionId}`;
    send({
      jsonrpc: '2.0',
      id: peerId,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: {
          toolCallId: 'tool_perm_1',
          title: 'Get-ChildItem -Force',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: 'Get-ChildItem -Force' },
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    pendingPeer.set(peerId, (response) => {
      const result = response.result;
      const outcome =
        result && typeof result === 'object' && result.outcome && typeof result.outcome === 'object'
          ? result.outcome
          : undefined;
      resolve({
        optionId: typeof outcome?.optionId === 'string' ? outcome.optionId : undefined,
        error: response.error ?? null,
        cancelled: pendingCancels.has(sessionId),
      });
    });
  });
}

const pendingPeer = new Map();
const sessions = new Set();
const sessionCurrentModels = new Map();
const pendingCancels = new Set();
const delayWaiters = new Map();
let sessionSeq = 0;
let initializeCount = 0;
let authenticateCount = 0;
let loadCount = 0;
let promptCount = 0;
let initializeFailRemaining = Number.parseInt(process.env.MOCK_ACP_FAIL_INITIALIZE ?? '0', 10);
if (!Number.isFinite(initializeFailRemaining) || initializeFailRemaining < 0) {
  initializeFailRemaining = 0;
}
const ignoreStdin = process.env.MOCK_ACP_IGNORE_STDIN === '1';
const ignoreSigterm = process.env.MOCK_ACP_IGNORE_SIGTERM === '1';

if (
  typeof process.env.MOCK_ACP_SPAWN_LOG === 'string' &&
  process.env.MOCK_ACP_SPAWN_LOG.length > 0
) {
  fs.appendFileSync(process.env.MOCK_ACP_SPAWN_LOG, `${process.pid}\n`);
}

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
      result: { initializeCount, authenticateCount, loadCount, promptCount },
    });
    return;
  }

  if (method === 'session/new') {
    sessionSeq += 1;
    const sessionId = `sess-${sessionSeq}`;
    sessions.add(sessionId);
    sessionCurrentModels.set(sessionId, 'mock-model');
    send({
      jsonrpc: '2.0',
      id,
      result: {
        sessionId,
        ...sessionMeta('mock-model'),
      },
    });
    return;
  }

  if (method === 'session/load') {
    loadCount += 1;
    if (process.env.MOCK_ACP_CRASH_ON_LOAD === '1') {
      process.exit(4);
      return;
    }
    if (process.env.MOCK_ACP_FAIL_LOAD === '1') {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: 'session/load failed' },
      });
      return;
    }
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
    if (!sessionCurrentModels.has(sessionId)) {
      sessionCurrentModels.set(sessionId, 'mock-model');
    }
    send({
      jsonrpc: '2.0',
      id,
      result: sessionMeta(sessionCurrentModels.get(sessionId)),
    });
    return;
  }

  if (method === 'session/prompt') {
    promptCount += 1;
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

  if (method === 'session/set_config_option') {
    const sessionId = params?.sessionId;
    const configId = params?.configId;
    const value = params?.value;
    if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Unknown session' },
      });
      return;
    }
    if (
      typeof configId !== 'string' ||
      configId.length === 0 ||
      typeof value !== 'string' ||
      value.length === 0
    ) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'configId and value are required' },
      });
      return;
    }
    const allowed = fixtureModels().some((model) => model.id === value);
    if (configId !== 'model' || !allowed) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Unknown model config option' },
      });
      return;
    }
    sessionCurrentModels.set(sessionId, value);
    const meta = sessionMeta(value);
    send({
      jsonrpc: '2.0',
      id,
      result: { configOptions: meta.configOptions, currentValue: value },
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
