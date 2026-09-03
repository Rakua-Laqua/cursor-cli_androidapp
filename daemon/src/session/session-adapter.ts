import { randomUUID } from 'node:crypto';

import type {
  AgentTerminalPayload,
  JsonObject,
  JsonValue,
  KnownRemoteEvent,
  ModelCatalogEntryPayload,
  ModelCatalogPayload,
  RemoteCommand,
  SessionPayload,
  SessionStatus,
} from '@cursor-remote/protocol';

import type { AcpIncomingRequest, AcpNotification, AcpProcess } from '../acp/process.js';
import { PermissionBridge } from '../permissions/permission-bridge.js';
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
  availableModels: ModelCatalogEntryPayload[];
  configOptions: JsonObject[];
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
  private readonly permissions: PermissionBridge;

  constructor(
    private readonly acp: AcpProcess,
    private readonly workspaces: WorkspaceManager,
    private readonly store?: MetadataStore,
  ) {
    this.permissions = new PermissionBridge({
      resolveRemoteSessionId: (cursorSessionId) =>
        this.resolveRunningRemoteSessionId(cursorSessionId),
      onRequested: (notice) => this.handlePermissionRequested(notice),
      onResolved: (notice) => this.handlePermissionResolved(notice),
    });
    this.acp.onNotification((notification) => this.handleNotification(notification));
    this.acp.onExit((info) => {
      this.permissions.rejectAllPending();
      if (info.expected) {
        return;
      }
      for (const session of this.sessions.values()) {
        if (session.status === 'running' || session.status === 'waiting_approval') {
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

  pendingPermissionSnapshot(remoteSessionId: string | null): {
    readonly permissionId: string;
    readonly kind: string;
    readonly command: string;
    readonly risk: 'high';
  } | null {
    if (remoteSessionId === null || remoteSessionId.length === 0) {
      return null;
    }
    return this.permissions.getPendingSnapshot(remoteSessionId);
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
    const catalog = readModelCatalog(result);
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
      selectedModelId: catalog.currentModelId,
      availableModels: catalog.models,
      configOptions: catalog.configOptions,
    };
    this.track(session);
    this.workspaces.markUsed(workspace.workspaceId);
    this.emitSession('session.created', session);
    this.emitCatalog(session);
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
    const catalog = readModelCatalog(loadResult);
    session.selectedModelId = catalog.currentModelId;
    session.availableModels = catalog.models;
    session.configOptions = catalog.configOptions;
    this.workspaces.markUsed(session.workspaceId);
    this.emitSession('session.loaded', session);
    this.emitStatus(session, 'idle');
    this.emitCatalog(session);
    this.persist();
    return toPayload(session);
  }

  list(workspaceId: string): SessionPayload[] {
    this.workspaces.require(workspaceId);
    return [...this.sessions.values()]
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => toPayload(session));
  }

  workspaceIdForSession(remoteSessionId: string): string {
    return this.requireSession(remoteSessionId).workspaceId;
  }

  async send(remoteSessionId: string, text: string): Promise<void> {
    const session = this.requireSession(remoteSessionId);
    await this.runPrompt(session, text);
  }

  async cancel(remoteSessionId: string): Promise<void> {
    const session = this.requireSession(remoteSessionId);
    this.permissions.rejectPendingForSession(remoteSessionId);
    this.acp.notify('session/cancel', { sessionId: session.cursorSessionId });
  }

  private listModels(remoteSessionId: string): ModelCatalogPayload {
    return toCatalogPayload(this.requireSession(remoteSessionId));
  }

  private async selectModel(
    remoteSessionId: string,
    modelId: string,
  ): Promise<ModelCatalogPayload> {
    const session = this.requireSession(remoteSessionId);
    assertPromptNotInProgress(session);
    if (modelId.length === 0) {
      throw new Error('modelId must be a string');
    }
    const selected = session.availableModels.find(
      (model) => model.id === modelId && model.available,
    );
    if (selected === undefined) {
      throw new Error('Unknown or unavailable model');
    }
    const configId = resolveModelConfigId(session.configOptions);
    if (configId === null) {
      throw new Error('Model config option is not available');
    }
    const result = await this.acp.request('session/set_config_option', {
      sessionId: session.cursorSessionId,
      configId,
      value: modelId,
    });
    const confirmedId = readConfirmedModelId(result, modelId);
    const nextOptions = readConfigOptions(result);
    session.selectedModelId = confirmedId;
    session.updatedAt = nowIso();
    if (nextOptions.length > 0) {
      session.configOptions = nextOptions;
    }
    this.persist();
    this.emit(session.remoteSessionId, 'model.selection_changed', {
      modelId: confirmedId,
      confirmed: true,
    });
    return toCatalogPayload(session);
  }

  handleIncomingRequest(request: AcpIncomingRequest): Promise<unknown> {
    if (request.method !== 'session/request_permission') {
      return Promise.reject(new Error(`Method not found: ${request.method}`));
    }
    return this.permissions.handleRequestPermission(request.params);
  }

  async handleCommand(
    command: RemoteCommand,
  ): Promise<SessionPayload | SessionPayload[] | ModelCatalogPayload | undefined> {
    switch (command.type) {
      case 'model.list':
        return this.listModels(readCommandSessionId(command.sessionId));
      case 'model.select':
        return this.selectModel(
          readCommandSessionId(command.sessionId),
          readCommandString(command.payload, 'modelId'),
        );
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
      case 'permission.approve':
        this.permissions.approve(
          readCommandSessionId(command.sessionId),
          readCommandString(command.payload, 'permissionId'),
        );
        return undefined;
      case 'permission.reject':
        this.permissions.reject(
          readCommandSessionId(command.sessionId),
          readCommandString(command.payload, 'permissionId'),
        );
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
      const result = await this.acp.request(
        'session/prompt',
        {
          sessionId: session.cursorSessionId,
          prompt: [{ type: 'text', text }],
        },
        0,
      );
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
    this.permissions.rejectPendingForSession(session.remoteSessionId);
    if (TERMINAL_SESSION_STATUSES.has(session.status)) {
      return;
    }
    const wasInPrompt = session.status === 'running' || session.status === 'waiting_approval';
    session.status = status;
    session.updatedAt = nowIso();
    this.emitStatus(session, status);
    if (wasInPrompt) {
      this.workspaces.adjustActiveSessionCount(session.workspaceId, -1);
    }
    const payload: AgentTerminalPayload = { reason };
    this.emit(session.remoteSessionId, type, payload);
    this.persist();
  }

  private resolveRunningRemoteSessionId(cursorSessionId: string): string | undefined {
    const remoteSessionId = this.remoteIdByCursorId.get(cursorSessionId);
    if (remoteSessionId === undefined) {
      return undefined;
    }
    const session = this.sessions.get(remoteSessionId);
    if (session === undefined || session.status !== 'running') {
      return undefined;
    }
    return remoteSessionId;
  }

  private handlePermissionRequested(notice: {
    readonly permissionId: string;
    readonly remoteSessionId: string;
    readonly kind: string;
    readonly command: string;
    readonly risk: 'high';
  }): void {
    const session = this.sessions.get(notice.remoteSessionId);
    if (session === undefined || TERMINAL_SESSION_STATUSES.has(session.status)) {
      return;
    }
    session.status = 'waiting_approval';
    session.updatedAt = nowIso();
    this.emitStatus(session, 'waiting_approval');
    this.emit(session.remoteSessionId, 'permission.requested', {
      permissionId: notice.permissionId,
      kind: notice.kind,
      command: notice.command,
      risk: notice.risk,
    });
  }

  private handlePermissionResolved(notice: {
    readonly permissionId: string;
    readonly remoteSessionId: string;
    readonly decision: 'approved' | 'rejected';
  }): void {
    const session = this.sessions.get(notice.remoteSessionId);
    if (session === undefined) {
      return;
    }
    if (session.status === 'waiting_approval') {
      session.status = 'running';
      session.updatedAt = nowIso();
      this.emitStatus(session, 'running');
    }
    this.emit(session.remoteSessionId, 'permission.resolved', {
      permissionId: notice.permissionId,
      decision: notice.decision,
    });
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

  private emitCatalog(session: TrackedSession): void {
    this.emit(session.remoteSessionId, 'model.catalog_updated', toCatalogPayload(session));
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
      availableModels: [],
      configOptions: [],
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

function toCatalogPayload(session: TrackedSession): ModelCatalogPayload {
  return {
    models: session.availableModels,
    currentModelId: session.selectedModelId,
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

function readModelCatalog(value: unknown): {
  models: ModelCatalogEntryPayload[];
  currentModelId: string | null;
  configOptions: JsonObject[];
} {
  return {
    models: readAvailableModels(value),
    currentModelId: readCurrentModelId(value),
    configOptions: readConfigOptions(value),
  };
}

function readAvailableModels(value: unknown): ModelCatalogEntryPayload[] {
  if (!isRecord(value) || !isRecord(value.models) || !Array.isArray(value.models.availableModels)) {
    return [];
  }
  const models: ModelCatalogEntryPayload[] = [];
  for (const entry of value.models.availableModels) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) {
      continue;
    }
    const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : null;
    const displayNameRaw =
      typeof entry.displayName === 'string' && entry.displayName.length > 0
        ? entry.displayName
        : null;
    const description =
      typeof entry.description === 'string' && entry.description.length > 0
        ? entry.description
        : null;
    models.push({
      id: entry.id,
      displayName: name ?? displayNameRaw ?? entry.id,
      description,
      parameters: readJsonValueArray(entry.parameters),
      variants: readJsonValueArray(entry.variants),
      available: entry.available === false ? false : true,
    });
  }
  return models;
}

function readConfigOptions(value: unknown): JsonObject[] {
  const raw = isRecord(value) && Array.isArray(value.configOptions) ? value.configOptions : value;
  if (!Array.isArray(raw)) {
    return [];
  }
  const options: JsonObject[] = [];
  for (const entry of raw) {
    if (isRecord(entry)) {
      options.push(entry as JsonObject);
    }
  }
  return options;
}

function resolveModelConfigId(options: JsonObject[]): string | null {
  for (const option of options) {
    const id = option.id;
    const category = option.category;
    if (typeof id !== 'string' || id.length === 0) {
      continue;
    }
    if (category === 'model' || id === 'model') {
      return id;
    }
  }
  return null;
}

function readConfirmedModelId(result: unknown, requestedId: string): string {
  if (isRecord(result)) {
    if (typeof result.currentValue === 'string' && result.currentValue.length > 0) {
      return result.currentValue;
    }
    if (typeof result.value === 'string' && result.value.length > 0) {
      return result.value;
    }
  }
  const options = readConfigOptions(result);
  const modelOption = options.find(
    (option) => option.category === 'model' || option.id === 'model',
  );
  const optionValue = modelOption?.currentValue ?? modelOption?.value;
  if (typeof optionValue === 'string' && optionValue.length > 0) {
    return optionValue;
  }
  return requestedId;
}

function readJsonValueArray(value: unknown): JsonValue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: JsonValue[] = [];
  for (const item of value) {
    if (isJsonValue(item)) {
      items.push(item);
    }
  }
  return items;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
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
  if (session.status === 'running' || session.status === 'waiting_approval') {
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
