import { randomUUID } from 'node:crypto';

import type {
  AgentTerminalPayload,
  JsonObject,
  KnownRemoteEvent,
  RemoteCommand,
  SessionPayload,
  SessionStatus,
} from '@cursor-remote/protocol';

import type { AcpNotification, AcpProcess } from '../acp/process.js';
import type { MetadataStore, PersistedSession } from '../store/metadata-store.js';
import type { WorkspaceManager } from '../workspace/workspace-manager.js';
import {
  mapAcpSessionUpdate,
  readAcpUpdateBody,
  readAcpUpdateSessionId,
} from './map-session-update.js';

export interface CreateSessionInput {
  readonly workspaceId: string;
  readonly initialPrompt: string;
  readonly title: string | null;
}

interface TrackedSession {
  readonly remoteSessionId: string;
  readonly cursorSessionId: string;
  readonly workspaceId: string;
  workspacePath: string;
  title: string;
  status: SessionStatus;
  readonly createdAt: string;
  updatedAt: string;
  lastEventId: string | null;
  selectedModelId: string | null;
}

const CLIENT_INFO = {
  name: 'cursor-remote-daemon',
  version: '1.2.1',
} as const;

const TERMINAL_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'completed',
  'failed',
  'interrupted',
  'disconnected',
]);

export class AcpSessionAdapter {
  private handshakeDone = false;
  private handshakePromise: Promise<void> | undefined;
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly remoteIdByCursorId = new Map<string, string>();
  private readonly listeners = new Set<(event: KnownRemoteEvent) => void>();

  constructor(
    private readonly acp: AcpProcess,
    private readonly workspaces: WorkspaceManager,
    private readonly store?: MetadataStore,
  ) {
    this.acp.onNotification((notification) => this.handleNotification(notification));
    this.acp.onExit((info) => {
      if (info.expected) {
        return;
      }
      for (const session of this.sessions.values()) {
        if (session.status === 'running') {
          this.finish(session, 'failed', 'agent.failed', 'ACP process exited');
        }
      }
    });
    this.hydrate();
  }

  onEvent(listener: (event: KnownRemoteEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async create(input: CreateSessionInput): Promise<SessionPayload> {
    const workspace = this.workspaces.require(input.workspaceId);
    await this.ensureHandshake();
    const cwd = this.workspaces.resolveTrustedPath(workspace.workspaceId);
    const createdAt = nowIso();
    const result = await this.acp.request('session/new', {
      cwd,
      mcpServers: [],
    });
    const cursorSessionId = readRequiredString(result, 'sessionId', 'session/new');
    const title = input.title ?? 'Session';
    const session: TrackedSession = {
      remoteSessionId: randomUUID(),
      cursorSessionId,
      workspaceId: workspace.workspaceId,
      workspacePath: cwd,
      title,
      status: 'idle',
      createdAt,
      updatedAt: createdAt,
      lastEventId: null,
      selectedModelId: readCurrentModelId(result),
    };
    this.track(session);
    this.workspaces.markUsed(workspace.workspaceId);
    this.emitSession('session.created', session);
    this.persist();
    if (input.initialPrompt.length > 0) {
      await this.runPrompt(session, input.initialPrompt);
    }
    return toPayload(session);
  }

  async load(remoteSessionId: string): Promise<SessionPayload> {
    await this.ensureHandshake();
    const session = this.requireSession(remoteSessionId);
    assertPromptNotInProgress(session);
    const cwd = this.workspaces.resolveTrustedPath(session.workspaceId);
    const loadResult = await this.acp.request('session/load', {
      sessionId: session.cursorSessionId,
      cwd,
      mcpServers: [],
    });
    session.status = 'idle';
    session.updatedAt = nowIso();
    session.workspacePath = cwd;
    session.selectedModelId = readCurrentModelId(loadResult);
    this.workspaces.markUsed(session.workspaceId);
    this.emitSession('session.loaded', session);
    this.emitStatus(session, 'idle');
    this.persist();
    return toPayload(session);
  }

  list(workspaceId: string): SessionPayload[] {
    this.workspaces.require(workspaceId);
    return [...this.sessions.values()]
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => toPayload(session));
  }

  async send(remoteSessionId: string, text: string): Promise<void> {
    const session = this.requireSession(remoteSessionId);
    await this.runPrompt(session, text);
  }

  async cancel(remoteSessionId: string): Promise<void> {
    const session = this.requireSession(remoteSessionId);
    this.acp.notify('session/cancel', { sessionId: session.cursorSessionId });
  }

  async handleCommand(
    command: RemoteCommand,
  ): Promise<SessionPayload | SessionPayload[] | undefined> {
    switch (command.type) {
      case 'session.create':
        return this.create({
          workspaceId: readCommandString(command.payload, 'workspaceId'),
          initialPrompt: readCommandString(command.payload, 'initialPrompt'),
          title: readCommandNullableString(command.payload, 'title'),
        });
      case 'session.load':
        return this.load(readCommandString(command.payload, 'remoteSessionId'));
      case 'session.list':
        return this.list(readCommandString(command.payload, 'workspaceId'));
      case 'session.send':
        await this.send(
          readCommandSessionId(command.sessionId),
          readCommandString(command.payload, 'text'),
        );
        return undefined;
      case 'session.cancel':
        await this.cancel(readCommandSessionId(command.sessionId));
        return undefined;
      default:
        throw new Error(`Unsupported command type: ${command.type}`);
    }
  }

  private async ensureHandshake(): Promise<void> {
    if (this.handshakeDone) {
      return;
    }
    if (this.handshakePromise === undefined) {
      this.handshakePromise = this.performHandshake().then(
        () => {
          this.handshakeDone = true;
        },
        (error: unknown) => {
          this.handshakePromise = undefined;
          throw error;
        },
      );
    }
    await this.handshakePromise;
  }

  private async performHandshake(): Promise<void> {
    await this.acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: CLIENT_INFO,
    });
    await this.acp.request('authenticate', { methodId: 'cursor_login' });
  }

  private async runPrompt(session: TrackedSession, text: string): Promise<void> {
    assertPromptNotInProgress(session);
    this.workspaces.markUsed(session.workspaceId);
    session.status = 'running';
    session.updatedAt = nowIso();
    this.workspaces.adjustActiveSessionCount(session.workspaceId, 1);
    this.emitStatus(session, 'running');
    this.emit(session.remoteSessionId, 'assistant.status', { status: 'running' });

    try {
      const result = await this.acp.request('session/prompt', {
        sessionId: session.cursorSessionId,
        prompt: [{ type: 'text', text }],
      });
      const stopReason = readStopReason(result);
      if (stopReason === 'cancelled') {
        this.finish(session, 'interrupted', 'agent.interrupted', stopReason);
        return;
      }
      this.finish(session, 'completed', 'agent.completed', stopReason);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.finish(session, 'failed', 'agent.failed', reason);
      throw error;
    }
  }

  private finish(
    session: TrackedSession,
    status: SessionStatus,
    type: 'agent.completed' | 'agent.failed' | 'agent.interrupted',
    reason: string | null,
  ): void {
    if (TERMINAL_SESSION_STATUSES.has(session.status)) {
      return;
    }
    const wasRunning = session.status === 'running';
    session.status = status;
    session.updatedAt = nowIso();
    this.emitStatus(session, status);
    if (wasRunning) {
      this.workspaces.adjustActiveSessionCount(session.workspaceId, -1);
    }
    const payload: AgentTerminalPayload = { reason };
    this.emit(session.remoteSessionId, type, payload);
    this.persist();
  }

  private handleNotification(notification: AcpNotification): void {
    if (notification.method !== 'session/update') {
      return;
    }
    const cursorSessionId = readAcpUpdateSessionId(notification.params);
    if (cursorSessionId === undefined) {
      return;
    }
    const remoteSessionId = this.remoteIdByCursorId.get(cursorSessionId);
    if (remoteSessionId === undefined) {
      return;
    }
    for (const mapped of mapAcpSessionUpdate(readAcpUpdateBody(notification.params))) {
      this.emit(remoteSessionId, mapped.type, mapped.payload);
    }
  }

  private track(session: TrackedSession): void {
    this.sessions.set(session.remoteSessionId, session);
    this.remoteIdByCursorId.set(session.cursorSessionId, session.remoteSessionId);
  }

  private requireSession(remoteSessionId: string): TrackedSession {
    const session = this.sessions.get(remoteSessionId);
    if (!session) {
      throw new Error(`Unknown session: ${remoteSessionId}`);
    }
    return session;
  }

  private emitSession(type: 'session.created' | 'session.loaded', session: TrackedSession): void {
    this.emit(session.remoteSessionId, type, toPayload(session));
  }

  private emitStatus(session: TrackedSession, status: SessionStatus): void {
    this.emit(session.remoteSessionId, 'session.status_changed', { status });
  }

  private emit(
    sessionId: string,
    type: KnownRemoteEvent['type'],
    payload: KnownRemoteEvent['payload'],
  ): void {
    const eventId = randomUUID();
    const event = {
      eventId,
      sessionId,
      timestamp: nowIso(),
      type,
      payload,
    } as KnownRemoteEvent;
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastEventId = eventId;
      this.persist();
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private hydrate(): void {
    if (this.store === undefined) {
      return;
    }
    for (const record of this.store.getSessions()) {
      try {
        this.restoreOne(record);
      } catch {
        // Leave unrestorable records on disk; do not expose them as live sessions.
      }
    }
  }

  private restoreOne(record: PersistedSession): void {
    const cwd = this.workspaces.resolveTrustedPath(record.workspaceId);
    const session: TrackedSession = {
      remoteSessionId: record.remoteSessionId,
      cursorSessionId: record.cursorSessionId,
      workspaceId: record.workspaceId,
      workspacePath: cwd,
      title: record.title,
      status: statusAfterRestore(record.status),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastEventId: record.lastEventId,
      selectedModelId: record.selectedModelId,
    };
    this.track(session);
  }

  private persist(): void {
    this.store?.writeSessions(
      [...this.sessions.values()].map((session) => ({
        remoteSessionId: session.remoteSessionId,
        cursorSessionId: session.cursorSessionId,
        workspaceId: session.workspaceId,
        title: session.title,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lastEventId: session.lastEventId,
        selectedModelId: session.selectedModelId,
      })),
    );
  }
}

function toPayload(session: TrackedSession): SessionPayload {
  return {
    remoteSessionId: session.remoteSessionId,
    cursorSessionId: session.cursorSessionId,
    workspaceId: session.workspaceId,
    title: session.title,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function statusAfterRestore(status: SessionStatus): SessionStatus {
  if (status === 'running' || status === 'waiting_approval' || status === 'waiting_user') {
    return 'disconnected';
  }
  return status;
}

function readRequiredString(value: unknown, key: string, source: string): string {
  if (!isRecord(value) || typeof value[key] !== 'string' || value[key].length === 0) {
    throw new Error(`${source} did not return ${key}`);
  }
  return value[key];
}

function readCurrentModelId(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.models)) {
    return null;
  }
  const modelId = value.models.currentModelId;
  return typeof modelId === 'string' && modelId.length > 0 ? modelId : null;
}

function readStopReason(value: unknown): string {
  if (!isRecord(value) || typeof value.stopReason !== 'string' || value.stopReason.length === 0) {
    return 'end_turn';
  }
  return value.stopReason;
}

function readCommandString(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function readCommandNullableString(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string or null`);
  }
  return value;
}

function assertPromptNotInProgress(session: TrackedSession): void {
  if (session.status === 'running') {
    throw new Error('Session already has a prompt in progress');
  }
}

function readCommandSessionId(sessionId: string | null): string {
  if (sessionId === null || sessionId.length === 0) {
    throw new Error('sessionId is required');
  }
  return sessionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
