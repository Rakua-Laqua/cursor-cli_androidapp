import { randomUUID } from 'node:crypto';

import type {
  DiffSnapshotPayload,
  JsonObject,
  KnownRemoteEvent,
  RemoteCommand,
} from '@cursor-remote/protocol';

import type { WorkspaceManager } from '../workspace/workspace-manager.js';
import { GitDiffSource, type DiffSource } from './git-diff-source.js';

export class DiffPipeline {
  private readonly listeners = new Set<(event: KnownRemoteEvent) => void>();

  constructor(
    private readonly workspaces: WorkspaceManager,
    private readonly source: DiffSource = new GitDiffSource(),
  ) {}

  onEvent(listener: (event: KnownRemoteEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  handleCommand(command: RemoteCommand): DiffSnapshotPayload {
    if (command.type !== 'diff.read') {
      throw new Error(`Unsupported command type: ${command.type}`);
    }
    const workspaceId = readCommandString(command.payload, 'workspaceId');
    const workspacePath = this.workspaces.resolveTrustedPath(workspaceId);
    const snapshot = this.source.collect({ workspaceId, workspacePath });
    this.emit(snapshot);
    return snapshot;
  }

  private emit(payload: DiffSnapshotPayload): void {
    const event = {
      eventId: randomUUID(),
      sessionId: null,
      timestamp: new Date().toISOString(),
      type: 'diff.updated',
      payload,
    } as KnownRemoteEvent;
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function readCommandString(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a string`);
  }
  return value;
}
