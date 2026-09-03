import { join } from 'node:path';

import {
  parseSyncCatchUpCommandPayload,
  parseSyncCatchUpResult,
  serializeEvent,
  type DiffSnapshotPayload,
  type FileContentPayload,
  type KnownRemoteEvent,
  type ModelCatalogPayload,
  type RemoteCommand,
  type SessionPayload,
  type SyncCatchUpResult,
  type WorkspaceUpdatedPayload,
} from '@cursor-remote/protocol';

import { AcpProcess, type AcpProcessLogger, type AcpProcessOptions } from './acp/process.js';
import { resolveAcpCommand } from './acp/resolve-command.js';
import { DiffPipeline } from './diff/diff-pipeline.js';
import { FileReader } from './file/file-reader.js';
import { PairingManager } from './pairing/pairing-manager.js';
import { AcpSessionAdapter } from './session/session-adapter.js';
import { METADATA_FILE_NAME, MetadataStore } from './store/metadata-store.js';
import { EventLog } from './sync/event-log.js';
import { WorkspaceManager, type WorkspaceManagerOptions } from './workspace/workspace-manager.js';

export interface DaemonAcpOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly onIncomingRequest?: AcpProcessOptions['onIncomingRequest'];
}

export interface DaemonStartOptions {
  readonly acp?: DaemonAcpOptions;
  readonly logger?: AcpProcessLogger;
  readonly workspaces?: WorkspaceManagerOptions;
  readonly stateDir?: string;
}

export class Daemon {
  private readonly eventLog = new EventLog();
  private readonly stopEventLog: () => void;

  private constructor(
    private readonly acpProcess: AcpProcess,
    private readonly sessionAdapter: AcpSessionAdapter,
    private readonly workspaceManager: WorkspaceManager,
    private readonly pairingManager: PairingManager,
    private readonly diffPipeline: DiffPipeline,
    private readonly fileReader: FileReader,
  ) {
    const append = (event: KnownRemoteEvent) => {
      this.eventLog.append(event);
    };
    const stopSessions = this.sessionAdapter.onEvent(append);
    const stopWorkspaces = this.workspaceManager.onEvent(append);
    const stopDiffs = this.diffPipeline.onEvent(append);
    this.stopEventLog = () => {
      stopSessions();
      stopWorkspaces();
      stopDiffs();
    };
  }

  static async start(options: DaemonStartOptions = {}): Promise<Daemon> {
    const resolved = options.acp?.command
      ? { command: options.acp.command, args: options.acp.args ?? [] }
      : resolveAcpCommand();

    const store =
      options.stateDir === undefined
        ? undefined
        : new MetadataStore(join(options.stateDir, METADATA_FILE_NAME));
    const workspaceManager = new WorkspaceManager(
      {
        allowedRoots: options.workspaces?.allowedRoots ?? [],
      },
      store,
    );

    let sessionAdapter: AcpSessionAdapter | undefined;
    const acpProcess = await AcpProcess.spawn({
      command: resolved.command,
      args: resolved.args,
      ...(options.acp?.cwd !== undefined ? { cwd: options.acp.cwd } : {}),
      ...(options.acp?.env !== undefined ? { env: options.acp.env } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.acp?.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.acp.requestTimeoutMs }
        : {}),
      ...(options.acp?.shutdownTimeoutMs !== undefined
        ? { shutdownTimeoutMs: options.acp.shutdownTimeoutMs }
        : {}),
      ...(options.acp?.onIncomingRequest !== undefined
        ? { onIncomingRequest: options.acp.onIncomingRequest }
        : {
            onIncomingRequest: (request) => {
              if (sessionAdapter === undefined) {
                return Promise.reject(new Error(`Method not found: ${request.method}`));
              }
              return sessionAdapter.handleIncomingRequest(request);
            },
          }),
    });

    try {
      sessionAdapter = new AcpSessionAdapter(acpProcess, workspaceManager, store);
      return new Daemon(
        acpProcess,
        sessionAdapter,
        workspaceManager,
        new PairingManager(store),
        new DiffPipeline(workspaceManager),
        new FileReader(sessionAdapter, workspaceManager),
      );
    } catch (error) {
      await acpProcess.shutdown();
      throw error;
    }
  }

  get acp(): AcpProcess {
    return this.acpProcess;
  }

  get sessions(): AcpSessionAdapter {
    return this.sessionAdapter;
  }

  get workspaces(): WorkspaceManager {
    return this.workspaceManager;
  }

  get pairing(): PairingManager {
    return this.pairingManager;
  }

  onEvent(listener: (event: KnownRemoteEvent) => void): () => void {
    const stopSessions = this.sessionAdapter.onEvent(listener);
    const stopWorkspaces = this.workspaceManager.onEvent(listener);
    const stopDiffs = this.diffPipeline.onEvent(listener);
    return () => {
      stopSessions();
      stopWorkspaces();
      stopDiffs();
    };
  }

  async handleCommand(
    command: RemoteCommand,
  ): Promise<
    | SessionPayload
    | SessionPayload[]
    | WorkspaceUpdatedPayload
    | WorkspaceUpdatedPayload[]
    | DiffSnapshotPayload
    | FileContentPayload
    | ModelCatalogPayload
    | SyncCatchUpResult
    | undefined
  > {
    if (command.type === 'sync.catch_up') {
      return this.catchUp(command);
    }
    if (command.type === 'workspace.list' || command.type === 'workspace.register') {
      return this.workspaceManager.handleCommand(command);
    }
    if (command.type === 'diff.read') {
      return this.diffPipeline.handleCommand(command);
    }
    if (command.type === 'file.read') {
      return this.fileReader.handleCommand(command);
    }
    return this.sessionAdapter.handleCommand(command);
  }

  async stop(): Promise<void> {
    this.stopEventLog();
    await this.acpProcess.shutdown();
  }

  private catchUp(command: RemoteCommand): SyncCatchUpResult {
    const { lastEventId } = parseSyncCatchUpCommandPayload(command.payload);
    const replay = this.eventLog.catchUp(lastEventId);
    return parseSyncCatchUpResult(
      JSON.parse(
        JSON.stringify({
          status: replay.status,
          events: replay.events.map((event) => JSON.parse(serializeEvent(event))),
          headEventId: replay.headEventId,
          pendingPermission: this.sessionAdapter.pendingPermissionSnapshot(command.sessionId),
        }),
      ),
    );
  }
}
