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

export interface KnownEventPayloads {
  readonly 'workspace.updated': WorkspaceUpdatedPayload;
  readonly 'session.created': SessionPayload;
  readonly 'session.loaded': SessionPayload;
  readonly 'session.status_changed': SessionStatusChangedPayload;
  readonly 'user.message': UserMessagePayload;
  readonly 'assistant.message': AssistantMessagePayload;
  readonly 'assistant.status': AssistantStatusPayload;
  readonly 'agent.waiting': AgentTerminalPayload;
  readonly 'agent.completed': AgentTerminalPayload;
  readonly 'agent.failed': AgentTerminalPayload;
  readonly 'agent.interrupted': AgentTerminalPayload;
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

export function parseRemoteEvent(json: string): ParsedRemoteEvent {
  const parsed: unknown = JSON.parse(json);
  const envelope = parseEventEnvelope(parsed);

  if (isKnownEventType(envelope.type)) {
    return envelope as KnownRemoteEvent;
  }

  return {
    ...envelope,
    knownType: false,
  };
}

export function parseRemoteCommand(json: string): RemoteCommand {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new ProtocolParseError('Command must be a JSON object.');
  }

  const requestId = requireString(parsed, 'requestId');
  const sessionId = requireNullableString(parsed, 'sessionId');
  const timestamp = requireString(parsed, 'timestamp');
  const type = requireString(parsed, 'type');
  const payload = requireJsonObject(parsed, 'payload');

  if (!isKnownCommandType(type)) {
    throw new ProtocolParseError(`Unknown command type: ${type}`);
  }

  return { requestId, sessionId, timestamp, type, payload };
}

export class ProtocolParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProtocolParseError';
  }
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
