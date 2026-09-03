import { serializeEvent, type KnownRemoteEvent } from '@cursor-remote/protocol';

export const EVENT_LOG_MAX_EVENTS = 2048;
export const EVENT_LOG_MAX_BYTES = 2 * 1024 * 1024;

export interface EventLogCatchUp {
  readonly status: 'replayed' | 'gap';
  readonly events: KnownRemoteEvent[];
  readonly headEventId: string | null;
}

interface StoredEvent {
  readonly event: KnownRemoteEvent;
  readonly bytes: number;
}

export class EventLog {
  private readonly stored: StoredEvent[] = [];
  private byteTotal = 0;
  private headEventId: string | null = null;

  append(event: KnownRemoteEvent): void {
    this.headEventId = event.eventId;
    const bytes = Buffer.byteLength(serializeEvent(event), 'utf8');
    if (bytes > EVENT_LOG_MAX_BYTES) {
      this.clearStored();
      return;
    }
    while (
      this.stored.length > 0 &&
      (this.stored.length >= EVENT_LOG_MAX_EVENTS || this.byteTotal + bytes > EVENT_LOG_MAX_BYTES)
    ) {
      this.evictOldest();
    }
    this.stored.push({ event, bytes });
    this.byteTotal += bytes;
  }

  catchUp(lastEventId: string | null): EventLogCatchUp {
    const headEventId = this.headEventId;
    if (lastEventId === null || lastEventId === headEventId) {
      return { status: 'replayed', events: [], headEventId };
    }
    const index = this.stored.findIndex((item) => item.event.eventId === lastEventId);
    if (index === -1) {
      return { status: 'gap', events: [], headEventId };
    }
    return {
      status: 'replayed',
      events: this.stored.slice(index + 1).map((item) => item.event),
      headEventId,
    };
  }

  private evictOldest(): void {
    const removed = this.stored.shift();
    if (removed === undefined) {
      return;
    }
    this.byteTotal -= removed.bytes;
  }

  private clearStored(): void {
    this.stored.length = 0;
    this.byteTotal = 0;
  }
}
