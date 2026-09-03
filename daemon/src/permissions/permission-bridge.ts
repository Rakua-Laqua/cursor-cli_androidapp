import { randomUUID } from 'node:crypto';

export const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_PERMISSION_KIND_LENGTH = 64;
export const MAX_PERMISSION_COMMAND_LENGTH = 512;

export type PermissionDecision = 'approved' | 'rejected';

export interface PermissionRequestedNotice {
  readonly permissionId: string;
  readonly remoteSessionId: string;
  readonly kind: string;
  readonly command: string;
  readonly risk: 'high';
}

export interface PermissionResolvedNotice {
  readonly permissionId: string;
  readonly remoteSessionId: string;
  readonly decision: PermissionDecision;
}

export interface PermissionBridgeOptions {
  readonly resolveRemoteSessionId: (cursorSessionId: string) => string | undefined;
  readonly onRequested: (notice: PermissionRequestedNotice) => void;
  readonly onResolved: (notice: PermissionResolvedNotice) => void;
  readonly timeoutMs?: number;
  readonly createPermissionId?: () => string;
}

interface PendingPermission {
  readonly permissionId: string;
  readonly remoteSessionId: string;
  readonly kind: string;
  readonly command: string;
  readonly risk: 'high';
  readonly allowOnceOptionId: string;
  readonly rejectOnceOptionId: string;
  readonly resolve: (value: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

export interface PendingPermissionSnapshot {
  readonly permissionId: string;
  readonly kind: string;
  readonly command: string;
  readonly risk: 'high';
}

const ALLOW_ONCE_KIND = 'allow_once';
const REJECT_ONCE_KIND = 'reject_once';

export class PermissionBridge {
  private readonly timeoutMs: number;
  private readonly createPermissionId: () => string;
  private readonly pendingBySession = new Map<string, PendingPermission>();
  private readonly pendingById = new Map<string, PendingPermission>();
  private readonly decidedBySession = new Map<string, string>();

  constructor(private readonly options: PermissionBridgeOptions) {
    this.timeoutMs = options.timeoutMs ?? PERMISSION_TIMEOUT_MS;
    this.createPermissionId = options.createPermissionId ?? randomUUID;
  }

  handleRequestPermission(params: unknown): Promise<unknown> {
    const parsed = parsePermissionParams(params);
    const rejectOnceOptionId = parsed?.rejectOnceOptionId;
    const allowOnceOptionId = parsed?.allowOnceOptionId;
    const remoteSessionId =
      parsed !== undefined && parsed.sessionId.length > 0
        ? this.options.resolveRemoteSessionId(parsed.sessionId)
        : undefined;
    const existing =
      remoteSessionId === undefined ? undefined : this.pendingBySession.get(remoteSessionId);
    if (
      parsed === undefined ||
      !parsed.validForWait ||
      remoteSessionId === undefined ||
      allowOnceOptionId === undefined ||
      rejectOnceOptionId === undefined ||
      existing !== undefined
    ) {
      if (rejectOnceOptionId !== undefined) {
        return Promise.resolve(selectedOutcome(rejectOnceOptionId));
      }
      return Promise.reject(new Error('Invalid permission request'));
    }

    const permissionId = this.createPermissionId();
    const kind = parsed.kind;
    const command = parsed.command;
    const sessionId = remoteSessionId;
    return new Promise((resolve) => {
      const pending: PendingPermission = {
        permissionId,
        remoteSessionId: sessionId,
        kind,
        command,
        risk: 'high',
        allowOnceOptionId,
        rejectOnceOptionId,
        resolve,
        settled: false,
        timer: setTimeout(() => {
          this.settle(pending, 'rejected');
        }, this.timeoutMs),
      };
      pending.timer.unref();
      this.pendingBySession.set(sessionId, pending);
      this.pendingById.set(permissionId, pending);
      this.options.onRequested({
        permissionId,
        remoteSessionId: sessionId,
        kind,
        command,
        risk: 'high',
      });
    });
  }

  approve(remoteSessionId: string, permissionId: string): void {
    this.decide(remoteSessionId, permissionId, 'approved');
  }

  reject(remoteSessionId: string, permissionId: string): void {
    this.decide(remoteSessionId, permissionId, 'rejected');
  }

  rejectPendingForSession(remoteSessionId: string): void {
    const pending = this.pendingBySession.get(remoteSessionId);
    if (pending === undefined) {
      return;
    }
    this.settle(pending, 'rejected');
  }

  rejectAllPending(): void {
    for (const pending of [...this.pendingById.values()]) {
      this.settle(pending, 'rejected');
    }
  }

  getPendingSnapshot(remoteSessionId: string): PendingPermissionSnapshot | null {
    const pending = this.pendingBySession.get(remoteSessionId);
    if (pending === undefined) {
      return null;
    }
    return {
      permissionId: pending.permissionId,
      kind: pending.kind,
      command: pending.command,
      risk: pending.risk,
    };
  }

  private decide(
    remoteSessionId: string,
    permissionId: string,
    decision: PermissionDecision,
  ): void {
    const pending = this.pendingById.get(permissionId);
    if (pending !== undefined) {
      if (pending.remoteSessionId !== remoteSessionId) {
        throw new Error('Permission session mismatch');
      }
      this.settle(pending, decision);
      return;
    }
    if (this.decidedBySession.get(remoteSessionId) === permissionId) {
      throw new Error('Permission already decided');
    }
    throw new Error('Unknown permission');
  }

  private settle(pending: PendingPermission, decision: PermissionDecision): void {
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    clearTimeout(pending.timer);
    this.pendingBySession.delete(pending.remoteSessionId);
    this.pendingById.delete(pending.permissionId);
    this.decidedBySession.set(pending.remoteSessionId, pending.permissionId);
    const optionId =
      decision === 'approved' ? pending.allowOnceOptionId : pending.rejectOnceOptionId;
    pending.resolve(selectedOutcome(optionId));
    this.options.onResolved({
      permissionId: pending.permissionId,
      remoteSessionId: pending.remoteSessionId,
      decision,
    });
  }
}

function selectedOutcome(optionId: string): unknown {
  return {
    outcome: {
      outcome: 'selected',
      optionId,
    },
  };
}

function parsePermissionParams(params: unknown):
  | {
      readonly sessionId: string;
      readonly validForWait: boolean;
      readonly kind: string;
      readonly command: string;
      readonly allowOnceOptionId: string | undefined;
      readonly rejectOnceOptionId: string | undefined;
    }
  | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const allowOnceOptionId = uniqueOptionId(params.options, ALLOW_ONCE_KIND);
  const rejectOnceOptionId = uniqueOptionId(params.options, REJECT_ONCE_KIND);
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  if (sessionId.length === 0 || !isRecord(params.toolCall)) {
    return {
      sessionId,
      validForWait: false,
      kind: '',
      command: '',
      allowOnceOptionId,
      rejectOnceOptionId,
    };
  }
  return {
    sessionId,
    validForWait: true,
    kind: extractKind(params.toolCall),
    command: extractCommand(params.toolCall),
    allowOnceOptionId,
    rejectOnceOptionId,
  };
}

function uniqueOptionId(options: unknown, kind: string): string | undefined {
  if (!Array.isArray(options)) {
    return undefined;
  }
  const matches: string[] = [];
  for (const option of options) {
    if (!isRecord(option) || option.kind !== kind) {
      continue;
    }
    if (typeof option.optionId !== 'string' || option.optionId.length === 0) {
      continue;
    }
    matches.push(option.optionId);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function extractKind(toolCall: Record<string, unknown>): string {
  if (typeof toolCall.kind !== 'string') {
    return '';
  }
  return truncate(toolCall.kind, MAX_PERMISSION_KIND_LENGTH);
}

function extractCommand(toolCall: Record<string, unknown>): string {
  if (typeof toolCall.title === 'string' && toolCall.title.length > 0) {
    return truncate(toolCall.title, MAX_PERMISSION_COMMAND_LENGTH);
  }
  const rawInput = toolCall.rawInput;
  if (isRecord(rawInput) && typeof rawInput.command === 'string' && rawInput.command.length > 0) {
    return truncate(rawInput.command, MAX_PERMISSION_COMMAND_LENGTH);
  }
  return '';
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
