export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export const EVENT_TYPES = [
  'workspace.updated',
  'model.catalog_updated',
  'model.selection_changed',
  'account.usage_updated',
  'session.created',
  'session.loaded',
  'session.status_changed',
  'session.context_updated',
  'session.context_breakdown_updated',
  'user.message',
  'assistant.message',
  'assistant.status',
  'tool.started',
  'tool.output',
  'tool.completed',
  'tool.failed',
  'command.started',
  'command.output',
  'command.completed',
  'command.failed',
  'permission.requested',
  'permission.resolved',
  'file.changed',
  'file.reference',
  'file.content',
  'diff.updated',
  'test.started',
  'test.completed',
  'agent.waiting',
  'agent.completed',
  'agent.failed',
  'agent.interrupted',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const COMMAND_TYPES = [
  'workspace.list',
  'workspace.register',
  'model.list',
  'model.select',
  'model.visibility.update',
  'account.usage.get',
  'session.list',
  'session.create',
  'session.load',
  'session.send',
  'session.cancel',
  'session.context.get',
  'session.context_breakdown.get',
  'permission.approve',
  'permission.reject',
  'file.read',
  'diff.read',
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_approval'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'disconnected';

export interface WorkspaceUpdatedPayload extends JsonObject {
  readonly workspaceId: string;
  readonly name: string;
  readonly path: string;
  readonly gitBranch: string | null;
  readonly modified: boolean;
  readonly activeSessionCount: number;
  readonly lastUsedAt: string | null;
}

export interface SessionPayload extends JsonObject {
  readonly remoteSessionId: string;
  readonly cursorSessionId: string | null;
  readonly workspaceId: string;
  readonly title: string;
  readonly status: SessionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionStatusChangedPayload extends JsonObject {
  readonly status: SessionStatus;
}

export interface UserMessagePayload extends JsonObject {
  readonly text: string;
}

export interface AssistantMessagePayload extends JsonObject {
  readonly text: string;
  readonly delta: boolean;
}

export interface AssistantStatusPayload extends JsonObject {
  readonly status: string;
}

export interface AgentTerminalPayload extends JsonObject {
  readonly reason: string | null;
}

export interface PermissionRequestedPayload extends JsonObject {
  readonly permissionId: string;
  readonly kind: string;
  readonly command: string;
  readonly risk: 'high';
}

export interface PermissionResolvedPayload extends JsonObject {
  readonly permissionId: string;
  readonly decision: 'approved' | 'rejected';
}

export interface PermissionDecisionCommandPayload extends JsonObject {
  readonly permissionId: string;
}

export type DiffChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export type DiffSourceKind = 'git' | 'none';

export interface DiffFilePayload extends JsonObject {
  readonly path: string;
  readonly previousPath: string | null;
  readonly change: DiffChangeKind;
  readonly binary: boolean;
  readonly sensitive: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly unifiedDiff: string | null;
  readonly truncated: boolean;
}

export interface DiffSnapshotPayload extends JsonObject {
  readonly workspaceId: string;
  readonly available: boolean;
  readonly source: DiffSourceKind;
  readonly files: DiffFilePayload[];
  readonly truncated: boolean;
  readonly omittedCount: number;
  readonly totalAdditions: number;
  readonly totalDeletions: number;
}

export interface ModelCatalogEntryPayload extends JsonObject {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly parameters: JsonValue[];
  readonly variants: JsonValue[];
  readonly available: boolean;
}

export interface ModelCatalogPayload extends JsonObject {
  readonly models: ModelCatalogEntryPayload[];
  readonly currentModelId: string | null;
}

export interface ModelSelectionChangedPayload extends JsonObject {
  readonly modelId: string;
  readonly confirmed: boolean;
}

export interface ModelListCommandPayload extends JsonObject {}

export interface ModelSelectCommandPayload extends JsonObject {
  readonly modelId: string;
}

export interface SessionContextUpdatedPayload extends JsonObject {
  readonly used: number;
  readonly size: number;
}

export interface KnownEventPayloads {
  readonly 'workspace.updated': WorkspaceUpdatedPayload;
  readonly 'model.catalog_updated': ModelCatalogPayload;
  readonly 'model.selection_changed': ModelSelectionChangedPayload;
  readonly 'session.created': SessionPayload;
  readonly 'session.loaded': SessionPayload;
  readonly 'session.status_changed': SessionStatusChangedPayload;
  readonly 'session.context_updated': SessionContextUpdatedPayload;
  readonly 'user.message': UserMessagePayload;
  readonly 'assistant.message': AssistantMessagePayload;
  readonly 'assistant.status': AssistantStatusPayload;
  readonly 'agent.waiting': AgentTerminalPayload;
  readonly 'agent.completed': AgentTerminalPayload;
  readonly 'agent.failed': AgentTerminalPayload;
  readonly 'agent.interrupted': AgentTerminalPayload;
  readonly 'permission.requested': PermissionRequestedPayload;
  readonly 'permission.resolved': PermissionResolvedPayload;
  readonly 'diff.updated': DiffSnapshotPayload;
}

export interface EventEnvelope<TType extends string, TPayload extends JsonValue> {
  readonly eventId: string;
  readonly sessionId: string | null;
  readonly timestamp: string;
  readonly type: TType;
  readonly payload: TPayload;
}

export type KnownRemoteEvent = {
  [TType in EventType]: EventEnvelope<
    TType,
    TType extends keyof KnownEventPayloads ? KnownEventPayloads[TType] : JsonObject
  >;
}[EventType];

export interface UnknownRemoteEvent extends EventEnvelope<string, JsonValue> {
  readonly knownType: false;
}

export type ParsedRemoteEvent = KnownRemoteEvent | UnknownRemoteEvent;

export interface RemoteCommand<
  TType extends CommandType = CommandType,
  TPayload extends JsonObject = JsonObject,
> {
  readonly requestId: string;
  readonly sessionId: string | null;
  readonly timestamp: string;
  readonly type: TType;
  readonly payload: TPayload;
}

export interface RemoteCommandResult {
  readonly requestId: string;
  readonly ok: boolean;
  readonly value: JsonValue | null;
  readonly error: string | null;
}

export type RemoteFrame =
  | {
      readonly kind: 'command';
      readonly command: RemoteCommand;
    }
  | {
      readonly kind: 'event';
      readonly event: ParsedRemoteEvent;
    }
  | {
      readonly kind: 'result';
      readonly result: RemoteCommandResult;
    };

export interface WorkspaceListCommandPayload extends JsonObject {}

export interface WorkspaceRegisterCommandPayload extends JsonObject {
  readonly path: string;
}

export interface SessionListCommandPayload extends JsonObject {
  readonly workspaceId: string;
}

export interface SessionCreateCommandPayload extends JsonObject {
  readonly workspaceId: string;
  readonly initialPrompt: string;
  readonly title: string | null;
}

export interface SessionLoadCommandPayload extends JsonObject {
  readonly remoteSessionId: string;
}

export interface SessionSendCommandPayload extends JsonObject {
  readonly text: string;
}

export interface SessionCancelCommandPayload extends JsonObject {}

export interface DiffReadCommandPayload extends JsonObject {
  readonly workspaceId: string;
}

export interface FileReadCommandPayload extends JsonObject {
  readonly path: string;
}

export interface FileContentPayload extends JsonObject {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

const eventTypeSet: ReadonlySet<string> = new Set(EVENT_TYPES);
const commandTypeSet: ReadonlySet<string> = new Set(COMMAND_TYPES);

export function isKnownEventType(type: string): type is EventType {
  return eventTypeSet.has(type);
}

export function isKnownCommandType(type: string): type is CommandType {
  return commandTypeSet.has(type);
}

export function serializeEvent(event: KnownRemoteEvent): string {
  return JSON.stringify(event);
}

export function serializeCommand(command: RemoteCommand): string {
  return JSON.stringify(command);
}

export function serializeRemoteCommandResult(result: RemoteCommandResult): string {
  return JSON.stringify(toResultObject(result));
}

export function serializeRemoteFrame(frame: RemoteFrame): string {
  if (frame.kind === 'command') {
    return JSON.stringify({ kind: 'command', command: frame.command });
  }
  if (frame.kind === 'event') {
    return JSON.stringify({ kind: 'event', event: frame.event });
  }
  return JSON.stringify({ kind: 'result', result: toResultObject(frame.result) });
}

export function remoteCommandSuccess(
  requestId: string,
  value: JsonValue | null | undefined,
): RemoteCommandResult {
  return {
    requestId,
    ok: true,
    value: value ?? null,
    error: null,
  };
}

export function remoteCommandFailure(requestId: string, error: unknown): RemoteCommandResult {
  return {
    requestId,
    ok: false,
    value: null,
    error: sanitizeRemoteErrorMessage(error),
  };
}

export function sanitizeRemoteErrorMessage(error: unknown): string {
  let message = 'Error';
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  }
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return firstLine.length > 0 ? firstLine : 'Error';
}

export function parseRemoteEvent(json: string): ParsedRemoteEvent {
  return parseEventRecord(JSON.parse(json));
}

export function parseRemoteCommand(json: string): RemoteCommand {
  return parseCommandRecord(JSON.parse(json));
}

export function parseRemoteCommandResult(json: string): RemoteCommandResult {
  return parseResultRecord(JSON.parse(json));
}

export function parseRemoteFrame(json: string): RemoteFrame {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new ProtocolParseError('Frame must be a JSON object.');
  }

  const kind = parsed.kind;
  if (kind === 'command') {
    return { kind: 'command', command: parseCommandRecord(parsed.command) };
  }
  if (kind === 'event') {
    return { kind: 'event', event: parseEventRecord(parsed.event) };
  }
  if (kind === 'result') {
    return { kind: 'result', result: parseResultRecord(parsed.result) };
  }

  throw new ProtocolParseError('kind must be command, event, or result.');
}

export class ProtocolParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProtocolParseError';
  }
}

function parseEventRecord(value: unknown): ParsedRemoteEvent {
  const envelope = parseEventEnvelope(value);

  if (isKnownEventType(envelope.type)) {
    return envelope as KnownRemoteEvent;
  }

  return {
    ...envelope,
    knownType: false,
  };
}

function parseCommandRecord(value: unknown): RemoteCommand {
  if (!isRecord(value)) {
    throw new ProtocolParseError('Command must be a JSON object.');
  }

  const requestId = requireString(value, 'requestId');
  const sessionId = requireNullableString(value, 'sessionId');
  const timestamp = requireString(value, 'timestamp');
  const type = requireString(value, 'type');
  const payload = requireJsonObject(value, 'payload');

  if (!isKnownCommandType(type)) {
    throw new ProtocolParseError(`Unknown command type: ${type}`);
  }

  return { requestId, sessionId, timestamp, type, payload };
}

function parseResultRecord(value: unknown): RemoteCommandResult {
  if (!isRecord(value)) {
    throw new ProtocolParseError('Result must be a JSON object.');
  }

  const requestId = requireString(value, 'requestId');
  if (typeof value.ok !== 'boolean') {
    throw new ProtocolParseError('ok must be a boolean.');
  }
  if (!('value' in value) || (value.value !== null && !isJsonValue(value.value))) {
    throw new ProtocolParseError('value must be valid JSON data or null.');
  }
  const error = value.error;
  if (error !== null && (typeof error !== 'string' || error.length === 0)) {
    throw new ProtocolParseError('error must be a non-empty string or null.');
  }

  if (value.ok) {
    if (error !== null) {
      throw new ProtocolParseError('successful result must have error null.');
    }
    return {
      requestId,
      ok: true,
      value: value.value as JsonValue | null,
      error: null,
    };
  }

  if (value.value !== null) {
    throw new ProtocolParseError('failed result must have value null.');
  }
  if (error === null) {
    throw new ProtocolParseError('failed result must have a non-empty error.');
  }
  return {
    requestId,
    ok: false,
    value: null,
    error,
  };
}

function toResultObject(result: RemoteCommandResult): RemoteCommandResult {
  return {
    requestId: result.requestId,
    ok: result.ok,
    value: result.ok ? (result.value ?? null) : null,
    error: result.ok ? null : sanitizeRemoteErrorMessage(result.error ?? 'Error'),
  };
}

function parseEventEnvelope(value: unknown): EventEnvelope<string, JsonValue> {
  if (!isRecord(value)) {
    throw new ProtocolParseError('Event must be a JSON object.');
  }

  return {
    eventId: requireString(value, 'eventId'),
    sessionId: requireNullableString(value, 'sessionId'),
    timestamp: requireString(value, 'timestamp'),
    type: requireString(value, 'type'),
    payload: requireJsonValue(value, 'payload'),
  };
}

function requireString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new ProtocolParseError(`${key} must be a non-empty string.`);
  }
  return candidate;
}

function requireNullableString(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key];
  if (candidate === null) {
    return null;
  }
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new ProtocolParseError(`${key} must be a non-empty string or null.`);
  }
  return candidate;
}

function requireJsonObject(value: Record<string, unknown>, key: string): JsonObject {
  const candidate = requireJsonValue(value, key);
  if (!isRecord(candidate) || Array.isArray(candidate)) {
    throw new ProtocolParseError(`${key} must be a JSON object.`);
  }
  return candidate as JsonObject;
}

function requireJsonValue(value: Record<string, unknown>, key: string): JsonValue {
  if (!(key in value) || !isJsonValue(value[key])) {
    throw new ProtocolParseError(`${key} must be valid JSON data.`);
  }
  return value[key] as JsonValue;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value !== 'number' || Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
