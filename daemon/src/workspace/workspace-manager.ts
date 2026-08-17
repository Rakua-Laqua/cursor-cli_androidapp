import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import type {
  JsonObject,
  KnownRemoteEvent,
  RemoteCommand,
  WorkspaceUpdatedPayload,
} from '@cursor-remote/protocol';

import { readGitInfo } from './git-info.js';
import {
  assertDirectoryAllowed,
  canonicalizeRoot,
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

  constructor(options: WorkspaceManagerOptions) {
    this.allowedRoots = options.allowedRoots.map((root) => canonicalizeRoot(root));
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

  markUsed(workspaceId: string): WorkspaceUpdatedPayload {
    const workspace = this.require(workspaceId);
    workspace.lastUsedAt = nowIso();
    this.refreshGit(workspace);
    const payload = toPayload(workspace);
    this.emit(payload);
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
    const git = readGitInfo(workspace.path);
    workspace.gitBranch = git.gitBranch;
    workspace.modified = git.modified;
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
