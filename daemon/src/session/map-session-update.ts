import type {
  AssistantMessagePayload,
  AssistantStatusPayload,
  SessionContextBreakdownCategoryPayload,
  SessionContextBreakdownUpdatedPayload,
  SessionContextUpdatedPayload,
  SessionCostPayload,
  SessionUsageUpdatedPayload,
  UserMessagePayload,
} from '@cursor-remote/protocol';

const CURRENCY_CODE = /^[A-Z]{3}$/;

export type MappedSessionEvent =
  | { readonly type: 'user.message'; readonly payload: UserMessagePayload }
  | { readonly type: 'assistant.message'; readonly payload: AssistantMessagePayload }
  | { readonly type: 'assistant.status'; readonly payload: AssistantStatusPayload }
  | { readonly type: 'session.context_updated'; readonly payload: SessionContextUpdatedPayload }
  | {
      readonly type: 'session.context_breakdown_updated';
      readonly payload: SessionContextBreakdownUpdatedPayload;
    }
  | { readonly type: 'session.usage_updated'; readonly payload: SessionUsageUpdatedPayload };

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

  if (kind === 'usage_update') {
    const used = readNonNegativeSafeInteger(update.used);
    const size = readNonNegativeSafeInteger(update.size);
    if (used === undefined || size === undefined) {
      return [];
    }
    const events: MappedSessionEvent[] = [
      { type: 'session.context_updated', payload: { used, size } },
    ];
    const categories = readContextBreakdown(update.breakdown);
    if (categories !== undefined) {
      events.push({
        type: 'session.context_breakdown_updated',
        payload: { categories },
      });
    }
    const cost = readSessionCost(update.cost);
    if (cost !== undefined) {
      events.push({ type: 'session.usage_updated', payload: { cost } });
    }
    return events;
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

function readNonNegativeSafeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function readContextBreakdown(
  value: unknown,
): SessionContextBreakdownCategoryPayload[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const categories: SessionContextBreakdownCategoryPayload[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return undefined;
    }
    if (typeof item.id !== 'string' || item.id.length === 0) {
      return undefined;
    }
    const tokens = readNonNegativeSafeInteger(item.tokens);
    if (tokens === undefined) {
      return undefined;
    }
    const displayName = typeof item.displayName === 'string' ? item.displayName : item.id;
    categories.push({ id: item.id, displayName, tokens });
  }
  return categories;
}

function readSessionCost(value: unknown): SessionCostPayload | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const amount = value.amount;
  const currency = value.currency;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    return undefined;
  }
  if (typeof currency !== 'string' || !CURRENCY_CODE.test(currency)) {
    return undefined;
  }
  return { amount, currency };
}
