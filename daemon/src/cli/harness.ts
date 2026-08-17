import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  KnownRemoteEvent,
  SessionPayload,
  WorkspaceUpdatedPayload,
} from '@cursor-remote/protocol';

import { Daemon, type DaemonAcpOptions, type DaemonStartOptions } from '../daemon.js';
import {
  RemoteDevUsageError,
  USAGE,
  type ParsedRemoteDevArgv,
  type RemoteDevCommand,
} from './argv.js';

const STREAM_PROMPT = 'e2e-stream';
const CONTINUE_PROMPT = 'e2e-continue';
const CANCEL_PROMPT = 'DELAY';
const STREAMABLE_EVENT_TYPES = new Set([
  'user.message',
  'assistant.message',
  'assistant.status',
  'session.status_changed',
  'agent.completed',
  'agent.failed',
  'agent.interrupted',
]);

export interface RemoteDevIo {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

export interface LocalE2eResult {
  readonly workspaceId: string;
  readonly remoteSessionId: string;
  readonly streamChunks: number;
  readonly streamedText: string;
  readonly interrupted: boolean;
  readonly continuedText: string;
}

export async function runParsedRemoteDev(
  parsed: ParsedRemoteDevArgv,
  io: RemoteDevIo,
): Promise<void> {
  if (parsed.command.kind === 'help') {
    io.stdout.write(USAGE);
    return;
  }
  if (parsed.command.kind === 'e2e') {
    const result = await runLocalE2e(resolveE2eStart(parsed), (line) => {
      io.stdout.write(`${line}\n`);
    });
    io.stdout.write(`e2e ok ${result.remoteSessionId}\n`);
    return;
  }

  const start = resolveOneShotStart(parsed);
  await withDaemon(start, async (daemon) => {
    await executeCommand(daemon, parsed.command, io, parsed.json);
  });
}

export async function runLocalE2e(
  options: DaemonStartOptions & { readonly workspacePath: string },
  onLog: (line: string) => void = () => {},
): Promise<LocalE2eResult> {
  const workspacePath = options.workspacePath;
  mkdirSync(workspacePath, { recursive: true });

  let workspaceId: string;
  let remoteSessionId: string;
  let streamChunks: number;
  let streamedText: string;
  let interrupted: boolean;

  const first = await Daemon.start(withoutWorkspacePath(options));
  try {
    const selected = first.workspaces.register(workspacePath);
    workspaceId = selected.workspaceId;
    onLog(`workspace selected ${workspaceId} ${selected.path}`);

    const created = await first.sessions.create({
      workspaceId,
      initialPrompt: '',
      title: 'e2e',
    });
    remoteSessionId = created.remoteSessionId;
    onLog(`session created ${remoteSessionId}`);

    const firstEvents: KnownRemoteEvent[] = [];
    const stopFirst = first.sessions.onEvent((event) => firstEvents.push(event));
    try {
      await first.sessions.send(remoteSessionId, STREAM_PROMPT);
      streamChunks = assistantChunks(firstEvents).length;
      streamedText = joinedAssistantText(firstEvents);
      if (streamChunks < 2) {
        throw new Error('expected streaming assistant.message deltas');
      }
      if (streamedText !== `echo:${STREAM_PROMPT}`) {
        throw new Error(`unexpected streamed text: ${streamedText}`);
      }
      onLog(`streamed ${streamedText}`);

      const thinkingBefore = countThinking(firstEvents);
      const sending = first.sessions.send(remoteSessionId, CANCEL_PROMPT);
      await waitUntil(() => countThinking(firstEvents) > thinkingBefore);
      await first.sessions.cancel(remoteSessionId);
      await sending;
      interrupted = firstEvents.some((event) => event.type === 'agent.interrupted');
      if (!interrupted) {
        throw new Error('expected agent.interrupted after cancel');
      }
      onLog('cancelled');
    } finally {
      stopFirst();
    }
  } finally {
    await first.stop();
  }

  onLog('daemon restarted');
  const second = await Daemon.start(withoutWorkspacePath(options));
  try {
    const listed = second.sessions.list(workspaceId);
    if (!listed.some((session) => session.remoteSessionId === remoteSessionId)) {
      throw new Error('session list after restart did not include the created session');
    }
    const loaded = await second.sessions.load(remoteSessionId);
    onLog(`session loaded ${loaded.remoteSessionId}`);

    const secondEvents: KnownRemoteEvent[] = [];
    const stopSecond = second.sessions.onEvent((event) => secondEvents.push(event));
    try {
      await second.sessions.send(remoteSessionId, CONTINUE_PROMPT);
      const continuedText = joinedAssistantText(secondEvents);
      if (continuedText !== `echo:${CONTINUE_PROMPT}`) {
        throw new Error(`unexpected continued text: ${continuedText}`);
      }
      onLog(`continued ${continuedText}`);
      return {
        workspaceId,
        remoteSessionId,
        streamChunks,
        streamedText,
        interrupted,
        continuedText,
      };
    } finally {
      stopSecond();
    }
  } finally {
    await second.stop();
  }
}

function resolveE2eStart(
  parsed: ParsedRemoteDevArgv,
): DaemonStartOptions & { readonly workspacePath: string } {
  const stateDir = parsed.stateDir ?? mkdtempSync(join(tmpdir(), 'remote-dev-state-'));
  const fallbackRoot = parsed.allowedRoots[0] ?? mkdtempSync(join(tmpdir(), 'remote-dev-root-'));
  const workspacePath =
    parsed.command.kind === 'e2e' && parsed.command.workspacePath !== undefined
      ? parsed.command.workspacePath
      : join(fallbackRoot, 'project');
  const allowedRoots = parsed.allowedRoots.length > 0 ? parsed.allowedRoots : [workspacePath];
  mkdirSync(workspacePath, { recursive: true });
  return {
    ...toStartOptions(stateDir, allowedRoots, parsed),
    workspacePath,
  };
}

function resolveOneShotStart(parsed: ParsedRemoteDevArgv): DaemonStartOptions {
  if (parsed.stateDir === undefined) {
    throw new RemoteDevUsageError('--state-dir or REMOTE_DEV_STATE_DIR is required');
  }
  if (parsed.allowedRoots.length === 0) {
    throw new RemoteDevUsageError('--allowed-root or REMOTE_DEV_ALLOWED_ROOTS is required');
  }
  return toStartOptions(parsed.stateDir, parsed.allowedRoots, parsed);
}

function toStartOptions(
  stateDir: string,
  allowedRoots: readonly string[],
  parsed: ParsedRemoteDevArgv,
): DaemonStartOptions {
  return {
    stateDir,
    workspaces: { allowedRoots },
    ...(parsed.acpCommand !== undefined
      ? {
          acp: {
            command: parsed.acpCommand,
            args: parsed.acpArgs,
            shutdownTimeoutMs: 1000,
          } satisfies DaemonAcpOptions,
        }
      : { acp: { shutdownTimeoutMs: 5000 } }),
  };
}

function withoutWorkspacePath(
  options: DaemonStartOptions & { readonly workspacePath: string },
): DaemonStartOptions {
  return {
    ...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
    ...(options.acp !== undefined ? { acp: options.acp } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.workspaces !== undefined ? { workspaces: options.workspaces } : {}),
  };
}

async function withDaemon<T>(
  options: DaemonStartOptions,
  fn: (daemon: Daemon) => Promise<T>,
): Promise<T> {
  const daemon = await Daemon.start(options);
  try {
    return await fn(daemon);
  } finally {
    await daemon.stop();
  }
}

async function executeCommand(
  daemon: Daemon,
  command: RemoteDevCommand,
  io: RemoteDevIo,
  json: boolean,
): Promise<void> {
  switch (command.kind) {
    case 'help':
    case 'e2e':
      return;
    case 'workspace.list':
      writeResult(io, json, daemon.workspaces.list());
      return;
    case 'workspace.register': {
      writeResult(io, json, daemon.workspaces.register(command.path));
      return;
    }
    case 'session.list': {
      writeResult(io, json, listSessions(daemon, command.workspaceId));
      return;
    }
    case 'session.create': {
      const created = await daemon.sessions.create({
        workspaceId: command.workspaceId,
        initialPrompt: command.initialPrompt,
        title: command.title,
      });
      writeResult(io, json, created);
      return;
    }
    case 'session.send':
      await daemon.sessions.load(command.remoteSessionId);
      await sendAndStream(daemon, command.remoteSessionId, command.text, io, json);
      return;
    case 'session.cancel':
      await daemon.sessions.cancel(command.remoteSessionId);
      return;
    case 'session.load': {
      writeResult(io, json, await daemon.sessions.load(command.remoteSessionId));
      return;
    }
  }
}

function listSessions(daemon: Daemon, workspaceId: string | undefined): SessionPayload[] {
  if (workspaceId !== undefined) {
    return daemon.sessions.list(workspaceId);
  }
  return daemon.workspaces
    .list()
    .flatMap((workspace) => daemon.sessions.list(workspace.workspaceId));
}

async function sendAndStream(
  daemon: Daemon,
  remoteSessionId: string,
  text: string,
  io: RemoteDevIo,
  json: boolean,
): Promise<void> {
  const stop = daemon.sessions.onEvent((event) => {
    if (event.sessionId !== remoteSessionId) {
      return;
    }
    if (!STREAMABLE_EVENT_TYPES.has(event.type)) {
      return;
    }
    if (json) {
      io.stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }
    io.stdout.write(`${formatEvent(event)}\n`);
  });
  const onSigint = () => {
    void daemon.sessions.cancel(remoteSessionId);
  };
  process.on('SIGINT', onSigint);
  try {
    await daemon.sessions.send(remoteSessionId, text);
  } finally {
    process.off('SIGINT', onSigint);
    stop();
  }
}

function writeResult(
  io: RemoteDevIo,
  json: boolean,
  value: WorkspaceUpdatedPayload | WorkspaceUpdatedPayload[] | SessionPayload | SessionPayload[],
): void {
  if (json) {
    io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const rows = Array.isArray(value) ? value : [value];
  for (const row of rows) {
    io.stdout.write(`${formatRow(row)}\n`);
  }
}

function formatRow(row: WorkspaceUpdatedPayload | SessionPayload): string {
  if (isSessionRow(row)) {
    return `${row.remoteSessionId}\t${row.status}\t${row.title}\t${row.workspaceId}`;
  }
  return `${row.workspaceId}\t${row.name}\t${row.path}`;
}

function isSessionRow(row: WorkspaceUpdatedPayload | SessionPayload): row is SessionPayload {
  return typeof (row as SessionPayload).remoteSessionId === 'string';
}

function formatEvent(event: KnownRemoteEvent): string {
  return `[${event.type}] ${JSON.stringify(event.payload)}`;
}

function assistantChunks(events: readonly KnownRemoteEvent[]): KnownRemoteEvent[] {
  return events.filter((event) => event.type === 'assistant.message');
}

function joinedAssistantText(events: readonly KnownRemoteEvent[]): string {
  return assistantChunks(events)
    .map((event) => (event.type === 'assistant.message' ? event.payload.text : ''))
    .join('');
}

function countThinking(events: readonly KnownRemoteEvent[]): number {
  return events.filter(
    (event) => event.type === 'assistant.status' && event.payload.status === 'thinking',
  ).length;
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
