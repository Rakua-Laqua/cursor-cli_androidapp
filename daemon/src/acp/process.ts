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
    const child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        CURSOR_INVOKED_AS: options.env?.CURSOR_INVOKED_AS ?? 'agent',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const processManager = new AcpProcess(child, options);

    await new Promise<void>((resolve, reject) => {
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

    return processManager;
  }

  readonly pid: number | undefined;

  private state: AcpProcessState = 'running';
  private nextId = 1;
  private expectedExit = false;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly stdout = new NdjsonBuffer();
  private readonly stderr = new NdjsonBuffer();
  private readonly notificationListeners = new Set<(notification: AcpNotification) => void>();
  private readonly exitListeners = new Set<(info: AcpExitInfo) => void>();
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly logger: AcpProcessLogger;
  private readonly onIncomingRequest: AcpProcessOptions['onIncomingRequest'];
  private exitInfo: AcpExitInfo | undefined;
  private readonly exited: Promise<AcpExitInfo>;
  private resolveExited: (info: AcpExitInfo) => void = () => {};

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    options: AcpProcessOptions,
  ) {
    this.pid = child.pid;
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

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    child.stderr.on('data', (chunk: string) => this.handleStderr(chunk));
    child.on('error', (error) => {
      this.logger.error(`ACP process error: ${error.message}`);
    });
    child.on('exit', (code, signal) => this.handleExit(code, signal));
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

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.state !== 'running') {
      return Promise.reject(new Error(`ACP process is ${this.state}`));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timer =
        this.requestTimeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`ACP request timed out: ${method}`));
            }, this.requestTimeoutMs)
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

  async shutdown(): Promise<void> {
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
      this.child.kill();
      const killed = await this.waitForExit(this.shutdownTimeoutMs);
      if (!killed && this.pid !== undefined) {
        try {
          process.kill(this.pid);
        } catch {
          // already gone
        }
        await this.waitForExit(this.shutdownTimeoutMs);
      }
    }
  }

  private handleStdout(chunk: string): void {
    for (const line of this.stdout.push(chunk)) {
      this.dispatch(parseJsonRpcLine(line));
    }
  }

  private handleStderr(chunk: string): void {
    for (const line of this.stderr.push(chunk)) {
      this.logger.error(line);
    }
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
          void this.handleIncomingRequest({
            id: message.id,
            method: message.method,
            params: message.params,
          });
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

  private async handleIncomingRequest(request: AcpIncomingRequest): Promise<void> {
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
      if (this.state === 'exited') {
        return;
      }
      this.write(encodeResult(request.id, result));
    } catch (error) {
      if (this.state === 'exited') {
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

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
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
    if (this.state === 'exited') {
      return;
    }
    this.child.stdin.write(payload);
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.state === 'exited') {
      return true;
    }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void this.exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
