import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { SessionStatus } from '@cursor-remote/protocol';

export const METADATA_STORE_VERSION = 1;
export const METADATA_FILE_NAME = 'metadata.json';

export class MetadataStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataStoreError';
  }
}

export interface PersistedWorkspace {
  readonly workspaceId: string;
  readonly path: string;
  readonly name: string;
  readonly lastUsedAt: string | null;
}

export interface PersistedSession {
  readonly remoteSessionId: string;
  readonly cursorSessionId: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly status: SessionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastEventId: string | null;
  readonly selectedModelId: string | null;
}

const SESSION_STATUSES: ReadonlySet<string> = new Set([
  'idle',
  'running',
  'waiting_approval',
  'waiting_user',
  'completed',
  'failed',
  'interrupted',
  'disconnected',
]);

export class MetadataStore {
  private workspaces: PersistedWorkspace[] = [];
  private sessions: PersistedSession[] = [];

  constructor(private readonly filePath: string | undefined) {
    if (this.filePath !== undefined) {
      this.readFromDisk();
    }
  }

  getWorkspaces(): readonly PersistedWorkspace[] {
    return this.workspaces;
  }

  getSessions(): readonly PersistedSession[] {
    return this.sessions;
  }

  writeWorkspaces(workspaces: readonly PersistedWorkspace[]): void {
    const currentIds = new Set(workspaces.map((workspace) => workspace.workspaceId));
    const currentPaths = new Set(workspaces.map((workspace) => workspace.path));
    const preserved = this.workspaces.filter(
      (workspace) => !currentIds.has(workspace.workspaceId) && !currentPaths.has(workspace.path),
    );
    this.workspaces = [...workspaces, ...preserved];
    this.flush();
  }

  writeSessions(sessions: readonly PersistedSession[]): void {
    const currentIds = new Set(sessions.map((session) => session.remoteSessionId));
    const preserved = this.sessions.filter((session) => !currentIds.has(session.remoteSessionId));
    this.sessions = [...sessions, ...preserved];
    this.flush();
  }

  private readFromDisk(): void {
    const filePath = this.filePath;
    if (filePath === undefined || !existsSync(filePath)) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw new MetadataStoreError(
        error instanceof Error ? error.message : `Invalid metadata store: ${filePath}`,
      );
    }

    if (!isRecord(parsed) || parsed.version !== METADATA_STORE_VERSION) {
      throw new MetadataStoreError(`Unsupported metadata store version in ${filePath}`);
    }

    this.workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces.flatMap((item) => {
          const workspace = parsePersistedWorkspace(item);
          return workspace === undefined ? [] : [workspace];
        })
      : [];
    this.sessions = Array.isArray(parsed.sessions)
      ? parsed.sessions.flatMap((item) => {
          const session = parsePersistedSession(item);
          return session === undefined ? [] : [session];
        })
      : [];
  }

  private flush(): void {
    if (this.filePath === undefined) {
      return;
    }
    atomicWriteFile(
      this.filePath,
      JSON.stringify({
        version: METADATA_STORE_VERSION,
        workspaces: this.workspaces,
        sessions: this.sessions,
      }),
    );
  }
}

export function atomicWriteFile(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, contents, 'utf8');
  try {
    renameSync(tmpPath, filePath);
  } catch {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    renameSync(tmpPath, filePath);
  }
}

function parsePersistedWorkspace(value: unknown): PersistedWorkspace | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const workspaceId = readNonEmptyString(value.workspaceId);
  const path = readNonEmptyString(value.path);
  const name = readNonEmptyString(value.name);
  const lastUsedAt = readNullableString(value.lastUsedAt);
  if (
    workspaceId === undefined ||
    path === undefined ||
    name === undefined ||
    lastUsedAt === undefined
  ) {
    return undefined;
  }
  return { workspaceId, path, name, lastUsedAt };
}

function parsePersistedSession(value: unknown): PersistedSession | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const remoteSessionId = readNonEmptyString(value.remoteSessionId);
  const cursorSessionId = readNonEmptyString(value.cursorSessionId);
  const workspaceId = readNonEmptyString(value.workspaceId);
  const title = typeof value.title === 'string' ? value.title : undefined;
  const status =
    typeof value.status === 'string' && SESSION_STATUSES.has(value.status)
      ? (value.status as SessionStatus)
      : undefined;
  const createdAt = readNonEmptyString(value.createdAt);
  const updatedAt = readNonEmptyString(value.updatedAt);
  const lastEventId = readNullableString(value.lastEventId);
  const selectedModelId = readNullableString(value.selectedModelId);
  if (
    remoteSessionId === undefined ||
    cursorSessionId === undefined ||
    workspaceId === undefined ||
    title === undefined ||
    status === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    lastEventId === undefined ||
    selectedModelId === undefined
  ) {
    return undefined;
  }
  return {
    remoteSessionId,
    cursorSessionId,
    workspaceId,
    title,
    status,
    createdAt,
    updatedAt,
    lastEventId,
    selectedModelId,
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return readNonEmptyString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
