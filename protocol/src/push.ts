import { ProtocolParseError } from './protocol.js';

export const PUSH_EVENT_TYPES = [
  'permission.requested',
  'agent.completed',
  'agent.failed',
  'agent.waiting',
] as const;

export type PushEventType = (typeof PUSH_EVENT_TYPES)[number];

const PUSH_TYPE_SET: ReadonlySet<string> = new Set(PUSH_EVENT_TYPES);
const PAYLOAD_KEYS = new Set(['eventId', 'type', 'machineId', 'sessionId']);

export interface FcmDataPayload {
  readonly eventId: string;
  readonly type: PushEventType;
  readonly machineId: string;
  readonly sessionId: string;
}

export function createFcmDataPayload(input: {
  readonly eventId: string;
  readonly type: string;
  readonly machineId: string;
  readonly sessionId: string | null | undefined;
}): FcmDataPayload {
  return parseFcmDataPayload({ ...input, sessionId: input.sessionId ?? '' });
}

export function parseFcmDataPayload(value: unknown): FcmDataPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolParseError('FCM data payload must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 4 || keys.some((key) => !PAYLOAD_KEYS.has(key))) {
    throw new ProtocolParseError('unexpected or missing fields.');
  }
  const type = typeof record.type === 'string' ? record.type : '';
  if (!PUSH_TYPE_SET.has(type)) {
    throw new ProtocolParseError('type must be a push event type.');
  }
  return {
    eventId: boundId(record.eventId, 'eventId', false),
    type: type as PushEventType,
    machineId: boundId(record.machineId, 'machineId', false),
    sessionId: boundId(record.sessionId, 'sessionId', true),
  };
}

function boundId(value: unknown, field: string, allowEmpty: boolean): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new ProtocolParseError(
      allowEmpty ? `${field} must be a string.` : `${field} must be a non-empty string.`,
    );
  }
  if (value.length > 512) {
    throw new ProtocolParseError(`${field} must be at most 512 characters.`);
  }
  return value;
}
