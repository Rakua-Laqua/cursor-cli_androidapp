import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResult,
  NdjsonBuffer,
  parseJsonRpcLine,
  type JsonRpcErrorObject,
  type JsonRpcId,
} from './json-rpc.js';
import { toSpawnableAcpCommand } from './resolve-command.js';

export type AcpProcessState = 'running' | 'stopping' | 'exited';

export interface AcpProcessLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface AcpIncomingRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: unknown;
}

export interface AcpNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface AcpExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly expected: boolean;
}

export interface AcpProcessOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: AcpProcessLogger;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly onIncomingRequest?: (request: AcpIncomingRequest) => Promise<unknown> | unknown;
}

export class AcpJsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcErrorObject) {
    super(error.message);
    this.name = 'AcpJsonRpcError';
    this.code = error.code;
    this.data = error.data;
  }
}

export class AcpProcessExitedError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(code: number | null, signal: NodeJS.Signals | null) {
    super(`ACP process exited (code=${code}, signal=${signal})`);
    this.name = 'AcpProcessExitedError';
    this.code = code;
    this.signal = signal;
  }
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;

export class AcpProcess {
  static async spawn(options: AcpProcessOptions): Promise<AcpProcess> {
    const child = launchChild(options);
    const processManager = new AcpProcess(child, options);
    await waitForChildSpawn(child);
    return processManager;
  }

  private child: ChildProcessWithoutNullStreams;
  private generation = 0;
  private state: AcpProcessState = 'running';
  private nextId = 1;
  private expectedExit = false;
  private shutdownRequested = false;
  private stderrNotified = false;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private stdout = new NdjsonBuffer();
  private readonly notificationListeners = new Set<(notification: AcpNotification) => void>();
  private readonly exitListeners = new Set<(info: AcpExitInfo) => void>();
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly logger: AcpProcessLogger;
  private readonly onIncomingRequest: AcpProcessOptions['onIncomingRequest'];
  private readonly options: AcpProcessOptions;
  private exitInfo: AcpExitInfo | undefined;
  private exited: Promise<AcpExitInfo>;
  private resolveExited: (info: AcpExitInfo) => void = () => {};

  private constructor(child: ChildProcessWithoutNullStreams, options: AcpProcessOptions) {
    this.child = child;
    this.options = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.logger = options.logger ?? {
      info() {},
      error() {},
    };
    this.onIncomingRequest = options.onIncomingRequest;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    this.attachChild(child, this.generation);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  getState(): AcpProcessState {
    return this.state;
  }

  onNotification(listener: (notification: AcpNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  onExit(listener: (info: AcpExitInfo) => void): () => void {
    this.exitListeners.add(listener);
    if (this.exitInfo) {
      listener(this.exitInfo);
    }
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.state !== 'running') {
      return Promise.reject(new Error(`ACP process is ${this.state}`));
    }

    const id = this.nextId;
    this.nextId += 1;
    const effectiveTimeoutMs = timeoutMs !== undefined ? timeoutMs : this.requestTimeoutMs;

    return new Promise<unknown>((resolve, reject) => {
      const timer =
        effectiveTimeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`ACP request timed out: ${method}`));
            }, effectiveTimeoutMs)
          : undefined;

      this.pending.set(id, { method, resolve, reject, timer });
      this.write(encodeRequest(id, method, params));
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.state !== 'running') {
      throw new Error(`ACP process is ${this.state}`);
    }
    this.write(encodeNotification(method, params));
  }

  async respawn(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      if (this.shutdownRequested) {
        throw new Error('ACP process is shutting down');
      }
      if (this.state === 'running' || this.state === 'stopping') {
        throw new Error(`ACP process is ${this.state}`);
      }
      if (this.exitInfo?.expected) {
        throw new Error('ACP process exited expectedly');
      }

      this.generation += 1;
      const generation = this.generation;
      this.resetGenerationState();
      try {
        const child = launchChild(this.options);
        this.child = child;
        this.attachChild(child, generation);
        await waitForChildSpawn(child);
      } catch (error) {
        await this.finalizeFailedSpawn(generation);
        throw error;
      }
      if (this.shutdownRequested || generation !== this.generation) {
        await this.shutdownCurrentChild();
        throw new Error('ACP process is shutting down');
      }
    });
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    return this.enqueueLifecycle(async () => {
      await this.shutdownCurrentChild();
    });
  }

  private attachChild(child: ChildProcessWithoutNullStreams, generation: number): void {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk, generation, child));
    child.stderr.on('data', (chunk: string) => this.handleStderr(chunk, generation, child));
    child.stdin.on('error', (error: Error) => {
      if (!this.isCurrentChild(generation, child)) {
        return;
      }
      this.logger.error(`ACP stdin error: ${error.message}`);
    });
    child.on('error', (error) => {
      if (!this.isCurrentChild(generation, child)) {
        return;
      }
      this.logger.error(`ACP process error: ${error.message}`);
    });
    child.on('exit', (code, signal) => this.handleExit(code, signal, generation, child));
  }

  private async shutdownCurrentChild(): Promise<void> {
    if (this.state === 'exited') {
      return;
    }

    this.state = 'stopping';
    this.expectedExit = true;
    this.rejectPending(new Error('ACP process is shutting down'));

    try {
      this.child.stdin.end();
    } catch {
      // stdin may already be closed
    }

    const completed = await this.waitForExit(this.shutdownTimeoutMs);
    if (!completed) {
      this.child.kill('SIGTERM');
      const terminated = await this.waitForExit(this.shutdownTimeoutMs);
      if (!terminated) {
        this.child.kill('SIGKILL');
        await this.waitForExit(this.shutdownTimeoutMs);
      }
    }
  }

  private handleStdout(
    chunk: string,
    generation: number,
    child: ChildProcessWithoutNullStreams,
  ): void {
    if (!this.isCurrentChild(generation, child)) {
      return;
    }
    for (const line of this.stdout.push(chunk)) {
      this.dispatch(parseJsonRpcLine(line));
    }
  }

  private handleStderr(
    chunk: string,
    generation: number,
    child: ChildProcessWithoutNullStreams,
  ): void {
    if (!this.isCurrentChild(generation, child)) {
      return;
    }
    if (this.stderrNotified) {
      return;
    }
    this.stderrNotified = true;
    this.logger.info('ACP stderr suppressed');
  }

  private dispatch(message: ReturnType<typeof parseJsonRpcLine>): void {
    try {
      switch (message.kind) {
        case 'success': {
          const pending = this.pending.get(message.id);
          if (!pending) {
            this.logger.info(`ACP received unmatched success id=${String(message.id)}`);
            return;
          }
          this.clearPending(message.id);
          pending.resolve(message.result);
          return;
        }
        case 'error': {
          if (message.id === null) {
            this.logger.error(`ACP JSON-RPC error without id: ${message.error.message}`);
            return;
          }
          const pending = this.pending.get(message.id);
          if (!pending) {
            this.logger.info(`ACP received unmatched error id=${String(message.id)}`);
            return;
          }
          this.clearPending(message.id);
          pending.reject(new AcpJsonRpcError(message.error));
          return;
        }
        case 'notification': {
          const notification = { method: message.method, params: message.params };
          for (const listener of this.notificationListeners) {
            listener(notification);
          }
          return;
        }
        case 'request': {
          void this.handleIncomingRequest(
            {
              id: message.id,
              method: message.method,
              params: message.params,
            },
            this.generation,
            this.child,
          );
          return;
        }
        case 'invalid': {
          this.logger.error(`ACP ignored invalid JSON-RPC: ${message.reason}`);
          return;
        }
      }
    } catch (error) {
      this.logger.error(
        `ACP stdout dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleIncomingRequest(
    request: AcpIncomingRequest,
    generation: number,
    child: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    if (!this.isCurrentChild(generation, child) || this.state !== 'running') {
      return;
    }

    try {
      if (!this.onIncomingRequest) {
        this.write(
          encodeError(request.id, {
            code: -32601,
            message: `Method not found: ${request.method}`,
            data: { method: request.method },
          }),
        );
        return;
      }

      const result = await this.onIncomingRequest(request);
      if (!this.isCurrentChild(generation, child) || this.state !== 'running') {
        return;
      }
      this.write(encodeResult(request.id, result));
    } catch (error) {
      if (!this.isCurrentChild(generation, child) || this.state !== 'running') {
        return;
      }
      this.write(
        encodeError(request.id, {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private handleExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    generation: number,
    child: ChildProcessWithoutNullStreams,
  ): void {
    if (!this.isCurrentChild(generation, child) || this.state === 'exited') {
      return;
    }
    this.settleExit(code, signal);
  }

  private async finalizeFailedSpawn(generation: number): Promise<void> {
    if (generation !== this.generation || this.state === 'exited') {
      return;
    }
    this.expectedExit = true;
    const child = this.child;
    try {
      child.kill('SIGKILL');
    } catch {
      // spawn may have failed before a process existed
    }
    if (!this.isCurrentChild(generation, child) || child.pid === undefined) {
      this.settleExit(null, null);
      return;
    }
    const completed = await this.waitForExit(this.shutdownTimeoutMs);
    if (!completed && generation === this.generation && this.getState() !== 'exited') {
      this.settleExit(null, null);
    }
  }

  private settleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.state === 'exited') {
      return;
    }
    const info: AcpExitInfo = {
      code,
      signal,
      expected: this.expectedExit,
    };
    this.state = 'exited';
    this.exitInfo = info;
    this.rejectPending(new AcpProcessExitedError(code, signal));
    this.resolveExited(info);
    for (const listener of this.exitListeners) {
      try {
        listener(info);
      } catch (error) {
        this.logger.error(
          `ACP exit listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.clearPending(id);
      pending.reject(error);
    }
  }

  private clearPending(id: JsonRpcId): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(id);
  }

  private write(payload: string): void {
    if (this.state !== 'running') {
      return;
    }
    try {
      this.child.stdin.write(payload);
    } catch (error) {
      this.logger.error(
        `ACP stdin write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.state === 'exited') {
      return true;
    }
    const exited = this.exited;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private resetGenerationState(): void {
    this.rejectPending(new Error('ACP process is respawning'));
    this.state = 'running';
    this.nextId = 1;
    this.expectedExit = false;
    this.stderrNotified = false;
    this.pending.clear();
    this.stdout = new NdjsonBuffer();
    this.exitInfo = undefined;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
  }

  private isCurrentChild(generation: number, child: ChildProcessWithoutNullStreams): boolean {
    return generation === this.generation && child === this.child;
  }

  private enqueueLifecycle(fn: () => Promise<void>): Promise<void> {
    const run = this.lifecycleQueue.then(fn, fn);
    this.lifecycleQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function launchChild(options: AcpProcessOptions): ChildProcessWithoutNullStreams {
  const launch = toSpawnableAcpCommand(
    options.command,
    options.args ?? [],
    process.platform,
    process.env,
  );
  return spawn(launch.command, [...launch.args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      CURSOR_INVOKED_AS: options.env?.CURSOR_INVOKED_AS ?? 'agent',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function waitForChildSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    const onSpawn = () => {
      child.off('error', onError);
      resolve();
    };
    child.once('error', onError);
    if (child.spawnfile && child.pid !== undefined) {
      child.off('error', onError);
      resolve();
      return;
    }
    child.once('spawn', onSpawn);
  });
}
