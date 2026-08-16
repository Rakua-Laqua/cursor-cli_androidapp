import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import type {
  AgentTerminalPayload,
  JsonObject,
  KnownRemoteEvent,
  RemoteCommand,
  SessionPayload,
  SessionStatus,
} from '@cursor-remote/protocol';

import type { AcpNotification, AcpProcess } from '../acp/process.js';
import {
  mapAcpSessionUpdate,
  readAcpUpdateBody,
  readAcpUpdateSessionId,
} from './map-session-update.js';

export interface CreateSessionInput {
  readonly workspacePath: string;
  readonly initialPrompt: string;
  readonly title: string | null;
}

interface TrackedSession {
  readonly remoteSessionId: string;
  readonly cursorSessionId: string;
  readonly workspacePath: string;
  title: string;
  status: SessionStatus;
  readonly createdAt: string;
  updatedAt: string;
}

const CLIENT_INFO = {
  name: 'cursor-remote-daemon',
  version: '0.3.0',
} as const;

export class AcpSessionAdapter {
  private handshakeDone = false;
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly remoteIdByCursorId = new Map<string, string>();
  private readonly listeners = new Set<(event: KnownRemoteEvent) => void>();

  constructor(private readonly acp: AcpProcess) {
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
  }

  onEvent(listener: (event: KnownRemoteEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async create(input: CreateSessionInput): Promise<SessionPayload> {
    const workspacePath = resolveWorkspacePath(input.workspacePath);
    await this.ensureHandshake();
    const createdAt = nowIso();
    const result = await this.acp.request('session/new', {
      cwd: workspacePath,
      mcpServers: [],
    });
    const cursorSessionId = readRequiredString(result, 'sessionId', 'session/new');
    const title = input.title ?? 'Session';
    const session: TrackedSession = {
      remoteSessionId: randomUUID(),
      cursorSessionId,
      workspacePath,
      title,
      status: 'idle',
      createdAt,
      updatedAt: createdAt,
    };
    this.track(session);
    this.emitSession('session.created', session);
    if (input.initialPrompt.length > 0) {
      await this.runPrompt(session, input.initialPrompt);
    }
    return toPayload(session);
  }

  async load(remoteSessionId: string): Promise<SessionPayload> {
    await this.ensureHandshake();
    const session = this.requireSession(remoteSessionId);
    await this.acp.request('session/load', {
      sessionId: session.cursorSessionId,
      cwd: session.workspacePath,
      mcpServers: [],
    });
    session.status = 'idle';
    session.updatedAt = nowIso();
    this.emitSession('session.loaded', session);
    this.emitStatus(session, 'idle');
    return toPayload(session);
  }

  async send(remoteSessionId: string, text: string): Promise<void> {
    const session = this.requireSession(remoteSessionId);
    await this.runPrompt(session, text);
  }

  async cancel(remoteSessionId: string): Promise<void> {
    const session = this.requireSession(remoteSessionId);
    this.acp.notify('session/cancel', { sessionId: session.cursorSessionId });
  }

  async handleCommand(command: RemoteCommand): Promise<SessionPayload | undefined> {
    switch (command.type) {
      case 'session.create':
        return this.create({
          workspacePath: readCommandString(command.payload, 'workspaceId'),
          initialPrompt: readCommandString(command.payload, 'initialPrompt'),
          title: readCommandNullableString(command.payload, 'title'),
        });
      case 'session.load':
        return this.load(readCommandString(command.payload, 'remoteSessionId'));
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
        throw new Error(`Unsupported command type in TASK-102: ${command.type}`);
    }
  }

  private async ensureHandshake(): Promise<void> {
    if (this.handshakeDone) {
      return;
    }
    await this.acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: CLIENT_INFO,
    });
    await this.acp.request('authenticate', { methodId: 'cursor_login' });
    this.handshakeDone = true;
  }

  private async runPrompt(session: TrackedSession, text: string): Promise<void> {
    session.status = 'running';
    session.updatedAt = nowIso();
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
    if (session.status === 'disconnected') {
      return;
    }
    session.status = status;
    session.updatedAt = nowIso();
    this.emitStatus(session, status);
    const payload: AgentTerminalPayload = { reason };
    this.emit(session.remoteSessionId, type, payload);
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
    const event = {
      eventId: randomUUID(),
      sessionId,
      timestamp: nowIso(),
      type,
      payload,
    } as KnownRemoteEvent;
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function toPayload(session: TrackedSession): SessionPayload {
  return {
    remoteSessionId: session.remoteSessionId,
    cursorSessionId: session.cursorSessionId,
    workspaceId: session.workspacePath,
    title: session.title,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function resolveWorkspacePath(workspacePath: string): string {
  const resolved = resolve(workspacePath);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolved}`);
  }
  return resolved;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readRequiredString(value: unknown, key: string, source: string): string {
  if (!isRecord(value) || typeof value[key] !== 'string' || value[key].length === 0) {
    throw new Error(`${source} did not return ${key}`);
  }
  return value[key];
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

function readCommandSessionId(sessionId: string | null): string {
  if (sessionId === null || sessionId.length === 0) {
    throw new Error('sessionId is required');
  }
  return sessionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
