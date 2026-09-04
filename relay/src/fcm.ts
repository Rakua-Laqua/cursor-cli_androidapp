import {
  createFcmDataPayload,
  PUSH_EVENT_TYPES,
  type FcmDataPayload,
  type ParsedRemoteEvent,
} from '@cursor-remote/protocol';

export type FcmSendStatus = 'sent' | 'drop-token' | 'retryable';

export interface FcmSender {
  send(token: string, data: FcmDataPayload): Promise<FcmSendStatus>;
}

export type SchedulePush = (delayMs: number, action: () => void) => { cancel(): void };

const SEND_URL = 'https://fcm.googleapis.com/v1/projects/';
const DEFAULT_TIMEOUT_MS = 8_000;
const TRACKED_EVENT_IDS = new Set<string>([
  ...PUSH_EVENT_TYPES,
  'permission.resolved',
  'agent.interrupted',
]);
const IMMEDIATE_PUSH = new Set(['permission.requested', 'agent.completed', 'agent.failed']);

export function createFcmSenderFromEnv(
  env: NodeJS.Dict<string> = process.env,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): FcmSender | undefined {
  if (!env.FCM_PROJECT_ID || !env.FCM_ACCESS_TOKEN) {
    return undefined;
  }
  return createHttpV1FcmSender({
    projectId: env.FCM_PROJECT_ID,
    getAccessToken: () => env.FCM_ACCESS_TOKEN,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}

export function createHttpV1FcmSender(options: {
  readonly projectId: string;
  readonly getAccessToken: () => string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}): FcmSender {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${SEND_URL}${encodeURIComponent(options.projectId)}/messages:send`;
  return {
    async send(token: string, data: FcmDataPayload): Promise<FcmSendStatus> {
      const accessToken = options.getAccessToken();
      if (!accessToken) {
        return 'retryable';
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token,
              data: {
                eventId: data.eventId,
                type: data.type,
                machineId: data.machineId,
                sessionId: data.sessionId,
              },
              android: { priority: 'HIGH' },
            },
          }),
          signal: controller.signal,
        });
        const body = await response.text();
        if (response.ok) {
          return 'sent';
        }
        return isUnregisteredResponse(body) ? 'drop-token' : 'retryable';
      } catch {
        return 'retryable';
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface PushDispatcherOptions {
  readonly sender?: FcmSender | undefined;
  readonly waitingDelayMs?: number | undefined;
  readonly schedule?: SchedulePush | undefined;
  readonly maxRegistry?: number | undefined;
  readonly maxSeenIds?: number | undefined;
}

interface TokenSlot {
  machineId: string;
  token: string;
  foreground: boolean;
  connection: object | null;
}

interface PendingWaiting {
  readonly handle: { cancel(): void };
}

export class PushDispatcher {
  private readonly sender: FcmSender | undefined;
  private readonly waitingDelayMs: number;
  private readonly schedule: SchedulePush;
  private readonly maxRegistry: number;
  private readonly maxSeenIds: number;
  private readonly slots = new Map<string, TokenSlot>();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly waiting = new Map<string, PendingWaiting>();
  private closed = false;

  public constructor(options: PushDispatcherOptions = {}) {
    this.sender = options.sender;
    this.waitingDelayMs = options.waitingDelayMs ?? 60_000;
    this.schedule = options.schedule ?? defaultSchedule;
    this.maxRegistry = options.maxRegistry ?? 1024;
    this.maxSeenIds = options.maxSeenIds ?? 4096;
  }

  register(input: {
    readonly machineId: string;
    readonly deviceId: string;
    readonly fcmToken: string | null;
    readonly appForeground: boolean;
    readonly connection: object;
  }): void {
    const key = `${input.machineId}\0${input.deviceId}`;
    if (input.fcmToken === null) {
      this.slots.delete(key);
      return;
    }
    this.slots.delete(key);
    this.slots.set(key, {
      machineId: input.machineId,
      token: input.fcmToken,
      foreground: input.appForeground,
      connection: input.connection,
    });
    while (this.slots.size > this.maxRegistry) {
      const oldest = this.slots.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.slots.delete(oldest);
    }
  }

  detach(connection: object): void {
    for (const slot of this.slots.values()) {
      if (slot.connection === connection) {
        slot.connection = null;
        slot.foreground = false;
      }
    }
  }

  onEvent(machineId: string, event: ParsedRemoteEvent): void {
    if (this.closed) return;
    try {
      this.dispatch(machineId, event);
    } catch {
      return;
    }
  }

  dispose(): void {
    this.closed = true;
    for (const pending of this.waiting.values()) {
      pending.handle.cancel();
    }
    this.waiting.clear();
    this.slots.clear();
    this.seen.clear();
    this.seenOrder.length = 0;
  }

  private dispatch(machineId: string, event: ParsedRemoteEvent): void {
    if (!TRACKED_EVENT_IDS.has(event.type) || !this.remember(event.eventId)) {
      return;
    }
    const sessionId = event.sessionId ?? '';
    this.cancelWaiting(machineId, sessionId);
    if (event.type === 'agent.waiting') {
      const payload = createFcmDataPayload({
        eventId: event.eventId,
        type: event.type,
        machineId,
        sessionId,
      });
      const waitKey = `${machineId}\0${sessionId}`;
      const pending: PendingWaiting = {
        handle: this.schedule(this.waitingDelayMs, () => {
          if (this.waiting.get(waitKey) !== pending || this.closed) {
            return;
          }
          this.waiting.delete(waitKey);
          void this.deliver(machineId, payload);
        }),
      };
      this.waiting.set(waitKey, pending);
      return;
    }
    if (IMMEDIATE_PUSH.has(event.type)) {
      void this.deliver(
        machineId,
        createFcmDataPayload({ eventId: event.eventId, type: event.type, machineId, sessionId }),
      );
    }
  }

  private cancelWaiting(machineId: string, sessionId: string): void {
    const key = `${machineId}\0${sessionId}`;
    this.waiting.get(key)?.handle.cancel();
    this.waiting.delete(key);
  }

  private async deliver(machineId: string, data: FcmDataPayload): Promise<void> {
    if (this.closed || this.sender === undefined) return;
    const targets = [...this.slots.entries()].filter(
      ([, slot]) => slot.machineId === machineId && !slot.foreground,
    );
    for (const [key, slot] of targets) {
      if (this.closed) return;
      const current = this.slots.get(key);
      if (current === undefined || current.foreground || current.token !== slot.token) continue;
      try {
        const status = await this.sender.send(slot.token, data);
        if (status === 'drop-token') {
          const latest = this.slots.get(key);
          if (latest !== undefined && latest.token === slot.token) this.slots.delete(key);
        }
      } catch {
        continue;
      }
    }
  }

  private remember(eventId: string): boolean {
    if (this.seen.has(eventId)) return false;
    this.seen.add(eventId);
    this.seenOrder.push(eventId);
    if (this.seenOrder.length > this.maxSeenIds) {
      this.seen.delete(this.seenOrder.shift() as string);
    }
    return true;
  }
}

function defaultSchedule(delayMs: number, action: () => void): { cancel(): void } {
  const timer = setTimeout(action, delayMs);
  return { cancel: () => clearTimeout(timer) };
}

function isUnregisteredResponse(body: string): boolean {
  try {
    return JSON.stringify(JSON.parse(body)).includes('"UNREGISTERED"');
  } catch {
    return false;
  }
}
