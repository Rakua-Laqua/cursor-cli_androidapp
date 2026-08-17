import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import type {
  JsonObject,
  KnownRemoteEvent,
  RemoteCommand,
  WorkspaceUpdatedPayload,
} from '@cursor-remote/protocol';

import type { MetadataStore, PersistedWorkspace } from '../store/metadata-store.js';
import { readGitInfo } from './git-info.js';
import {
  assertDirectoryAllowed,
  freezeAllowedRoot,
  WorkspaceNotAllowedError,
  WorkspacePathError,
} from './path-guard.js';

export class WorkspaceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceNotFoundError';
  }
}

export interface WorkspaceManagerOptions {
  readonly allowedRoots: readonly string[];
}

interface TrackedWorkspace {
  readonly workspaceId: string;
  readonly path: string;
  name: string;
  gitBranch: string | null;
  modified: boolean;
  activeSessionCount: number;
  lastUsedAt: string | null;
}

export class WorkspaceManager {
  private readonly allowedRoots: readonly string[];
  private readonly workspaces = new Map<string, TrackedWorkspace>();
  private readonly idByPath = new Map<string, string>();
  private readonly listeners = new Set<(event: KnownRemoteEvent) => void>();

  constructor(
    options: WorkspaceManagerOptions,
    private readonly store?: MetadataStore,
  ) {
    this.allowedRoots = options.allowedRoots.map((root) => freezeAllowedRoot(root));
    this.hydrate();
  }

  onEvent(listener: (event: KnownRemoteEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  register(path: string): WorkspaceUpdatedPayload {
    const canonical = assertDirectoryAllowed(path, this.allowedRoots);
    const existingId = this.idByPath.get(canonical);
    if (existingId !== undefined) {
      const existing = this.require(existingId);
      this.refreshGit(existing);
      const payload = toPayload(existing);
      this.emit(payload);
      this.persist();
      return payload;
    }

    const stored = this.findStoredRecordForPath(canonical);
    if (stored !== undefined) {
      this.restoreOne({ ...stored, path: canonical });
      const restored = this.require(stored.workspaceId);
      this.refreshGit(restored);
      const payload = toPayload(restored);
      this.emit(payload);
      this.persist();
      return payload;
    }

    const workspace: TrackedWorkspace = {
      workspaceId: randomUUID(),
      path: canonical,
      name: workspaceName(canonical),
      ...readGitInfo(canonical),
      activeSessionCount: 0,
      lastUsedAt: null,
    };
    this.workspaces.set(workspace.workspaceId, workspace);
    this.idByPath.set(canonical, workspace.workspaceId);
    const payload = toPayload(workspace);
    this.emit(payload);
    this.persist();
    return payload;
  }

  list(): WorkspaceUpdatedPayload[] {
    return [...this.workspaces.values()].map((workspace) => {
      this.refreshGit(workspace);
      return toPayload(workspace);
    });
  }

  require(workspaceId: string): TrackedWorkspace {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new WorkspaceNotFoundError(`Unknown workspace: ${workspaceId}`);
    }
    return workspace;
  }

  resolveTrustedPath(workspaceId: string): string {
    const workspace = this.require(workspaceId);
    return assertDirectoryAllowed(workspace.path, this.allowedRoots);
  }

  markUsed(workspaceId: string): WorkspaceUpdatedPayload {
    const workspace = this.require(workspaceId);
    workspace.lastUsedAt = nowIso();
    this.refreshGit(workspace);
    const payload = toPayload(workspace);
    this.emit(payload);
    this.persist();
    return payload;
  }

  adjustActiveSessionCount(workspaceId: string, delta: number): void {
    const workspace = this.require(workspaceId);
    workspace.activeSessionCount = Math.max(0, workspace.activeSessionCount + delta);
    this.emit(toPayload(workspace));
  }

  handleCommand(command: RemoteCommand): WorkspaceUpdatedPayload | WorkspaceUpdatedPayload[] {
    switch (command.type) {
      case 'workspace.register':
        return this.register(readCommandString(command.payload, 'path'));
      case 'workspace.list':
        return this.list();
      default:
        throw new Error(`Unsupported command type in TASK-103: ${command.type}`);
    }
  }

  private refreshGit(workspace: TrackedWorkspace): void {
    const trustedPath = this.resolveTrustedPath(workspace.workspaceId);
    const git = readGitInfo(trustedPath);
    workspace.gitBranch = git.gitBranch;
    workspace.modified = git.modified;
  }

  private hydrate(): void {
    if (this.store === undefined) {
      return;
    }
    for (const record of this.store.getWorkspaces()) {
      try {
        this.restoreOne(record);
      } catch {
        // Leave unrestorable records on disk; do not expose them as live workspaces.
      }
    }
  }

  private restoreOne(record: PersistedWorkspace): void {
    const canonical = assertDirectoryAllowed(record.path, this.allowedRoots);
    const existingId = this.idByPath.get(canonical);
    if (existingId !== undefined) {
      return;
    }
    const workspace: TrackedWorkspace = {
      workspaceId: record.workspaceId,
      path: canonical,
      name: record.name,
      ...readGitInfo(canonical),
      activeSessionCount: 0,
      lastUsedAt: record.lastUsedAt,
    };
    this.workspaces.set(workspace.workspaceId, workspace);
    this.idByPath.set(canonical, workspace.workspaceId);
  }

  private findStoredRecordForPath(canonical: string): PersistedWorkspace | undefined {
    if (this.store === undefined) {
      return undefined;
    }
    for (const record of this.store.getWorkspaces()) {
      if (this.workspaces.has(record.workspaceId)) {
        continue;
      }
      try {
        if (assertDirectoryAllowed(record.path, this.allowedRoots) === canonical) {
          return record;
        }
      } catch {
        // Stored path is still outside the frozen allowedRoots.
      }
    }
    return undefined;
  }

  private persist(): void {
    this.store?.writeWorkspaces(
      [...this.workspaces.values()].map((workspace) => ({
        workspaceId: workspace.workspaceId,
        path: workspace.path,
        name: workspace.name,
        lastUsedAt: workspace.lastUsedAt,
      })),
    );
  }

  private emit(payload: WorkspaceUpdatedPayload): void {
    const event = {
      eventId: randomUUID(),
      sessionId: null,
      timestamp: nowIso(),
      type: 'workspace.updated',
      payload,
    } as KnownRemoteEvent;
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function toPayload(workspace: TrackedWorkspace): WorkspaceUpdatedPayload {
  return {
    workspaceId: workspace.workspaceId,
    name: workspace.name,
    path: workspace.path,
    gitBranch: workspace.gitBranch,
    modified: workspace.modified,
    activeSessionCount: workspace.activeSessionCount,
    lastUsedAt: workspace.lastUsedAt,
  };
}

function workspaceName(canonical: string): string {
  const name = basename(canonical);
  return name.length > 0 ? name : canonical;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readCommandString(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

export { WorkspaceNotAllowedError, WorkspacePathError };
