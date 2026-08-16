import type {
  AssistantMessagePayload,
  AssistantStatusPayload,
  UserMessagePayload,
} from '@cursor-remote/protocol';

export type MappedSessionEvent =
  | { readonly type: 'user.message'; readonly payload: UserMessagePayload }
  | { readonly type: 'assistant.message'; readonly payload: AssistantMessagePayload }
  | { readonly type: 'assistant.status'; readonly payload: AssistantStatusPayload };

export function mapAcpSessionUpdate(update: unknown): MappedSessionEvent[] {
  if (!isRecord(update)) {
    return [];
  }

  const kind = update.sessionUpdate;
  if (typeof kind !== 'string' || kind.length === 0) {
    return [];
  }

  if (kind === 'user_message_chunk') {
    const text = readContentText(update.content);
    return text === undefined ? [] : [{ type: 'user.message', payload: { text } }];
  }

  if (kind === 'agent_message_chunk') {
    const text = readContentText(update.content);
    return text === undefined
      ? []
      : [{ type: 'assistant.message', payload: { text, delta: true } }];
  }

  if (kind === 'agent_thought_chunk') {
    return [{ type: 'assistant.status', payload: { status: 'thinking' } }];
  }

  return [];
}

export function readAcpUpdateSessionId(params: unknown): string | undefined {
  if (!isRecord(params) || typeof params.sessionId !== 'string' || params.sessionId.length === 0) {
    return undefined;
  }
  return params.sessionId;
}

export function readAcpUpdateBody(params: unknown): unknown {
  if (!isRecord(params)) {
    return undefined;
  }
  return params.update;
}

function readContentText(content: unknown): string | undefined {
  if (!isRecord(content) || typeof content.text !== 'string') {
    return undefined;
  }
  return content.text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
