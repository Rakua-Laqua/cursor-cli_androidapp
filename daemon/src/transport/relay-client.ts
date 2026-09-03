import { createRequire } from 'node:module';

import {
  parseTransportFrame,
  remoteCommandFailure,
  remoteCommandSuccess,
  sanitizeRemoteErrorMessage,
  serializeTransportFrame,
  type JsonValue,
  type PairingVerifyFrame,
  type RemoteCommand,
  type TransportFrame,
} from '@cursor-remote/protocol';

import type { Daemon } from '../daemon.js';

interface WsConstructor {
  new (url: string): DaemonSocket;
  readonly OPEN: number;
  readonly CLOSING: number;
  readonly CLOSED: number;
}

interface DaemonSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): void;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  once(event: 'open', listener: () => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'close', listener: (code: number, reason: Buffer) => void): void;
}

const WebSocket = createRequire(import.meta.url)('ws') as WsConstructor;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 10_000;
const MACHINE_REPLACED_CLOSE_CODE = 1000;
const MACHINE_REPLACED_CLOSE_REASON = 'Machine replaced';

export class DaemonRelayConnection {
  private closed = false;
  private everOpened = false;
  private connecting = false;
  private generation = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private socket: DaemonSocket | undefined;
  private readonly stopEvents: () => void;
  private readonly machineId: string;

  private constructor(
    private readonly daemon: Daemon,
    private readonly url: string,
  ) {
    this.machineId = readMachineId(url);
    this.stopEvents = daemon.onEvent((event) => {
      this.sendFrame({ kind: 'event', event });
    });
  }

  static async connect(daemon: Daemon, url: string): Promise<DaemonRelayConnection> {
    const connection = new DaemonRelayConnection(daemon, url);
    try {
      await connection.openSocket();
      connection.everOpened = true;
      return connection;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearReconnectTimer();
    this.generation += 1;
    this.stopEvents();
    const socket = this.socket;
    this.socket = undefined;
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
      return;
    }
    if (socket.readyState !== WebSocket.CLOSING) {
      socket.close();
    }
    await waitForClose(socket);
  }

  private async openSocket(): Promise<void> {
    if (this.closed) {
      throw new Error('Relay connection closed');
    }
    this.connecting = true;
    const generation = this.generation + 1;
    this.generation = generation;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.on('message', (data, isBinary) => {
      if (this.generation !== generation || this.closed) {
        return;
      }
      this.onMessage(data, isBinary, generation);
    });
    socket.on('close', (code, reason) => {
      if (this.generation !== generation || this.closed) {
        return;
      }
      if (isMachineReplacedClose(code, reason)) {
        this.markReplaced();
        return;
      }
      this.scheduleReconnect();
    });
    socket.on('error', () => {
      if (this.generation !== generation || this.closed) {
        return;
      }
      socket.close();
    });
    try {
      await waitForOpen(socket);
      if (this.closed || this.generation !== generation) {
        if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
          socket.close();
        }
        throw new Error('Relay connection closed');
      }
      this.reconnectAttempt = 0;
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.everOpened || this.connecting || this.reconnectTimer !== undefined) {
      return;
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private async reconnect(): Promise<void> {
    if (this.closed || this.connecting) {
      return;
    }
    try {
      await this.openSocket();
    } catch {
      if (!this.closed) {
        this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 16);
        this.scheduleReconnect();
      }
    }
  }

  private markReplaced(): void {
    this.closed = true;
    this.clearReconnectTimer();
    this.generation += 1;
    this.stopEvents();
    this.socket = undefined;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private onMessage(data: unknown, isBinary: boolean, generation: number): void {
    const text = readTextFrame(data, isBinary);
    if (text === undefined) {
      return;
    }

    let frame: TransportFrame;
    try {
      frame = parseTransportFrame(text);
    } catch {
      return;
    }
    if (frame.kind === 'pairing_verify') {
      this.dispatchPairingVerify(frame, generation);
      return;
    }
    if (frame.kind !== 'command') {
      return;
    }
    void this.dispatch(frame.command, generation);
  }

  private dispatchPairingVerify(frame: PairingVerifyFrame, generation: number): void {
    if (frame.machineId !== this.machineId) {
      this.sendFrame(
        {
          kind: 'pairing_result',
          verificationId: frame.verificationId,
          ok: false,
          deviceId: null,
          error: 'Machine mismatch',
        },
        generation,
      );
      return;
    }

    try {
      const deviceId =
        frame.operation === 'pair'
          ? this.daemon.pairing.verifyPair({
              machineId: this.machineId,
              nonce: frame.nonce,
              token: frame.token,
              publicKey: frame.publicKey,
              signature: frame.signature,
            }).deviceId
          : this.daemon.pairing.verifyAuth({
              machineId: this.machineId,
              nonce: frame.nonce,
              deviceId: frame.deviceId,
              signature: frame.signature,
            }).deviceId;
      this.sendFrame(
        {
          kind: 'pairing_result',
          verificationId: frame.verificationId,
          ok: true,
          deviceId,
          error: null,
        },
        generation,
      );
    } catch (error) {
      this.sendFrame(
        {
          kind: 'pairing_result',
          verificationId: frame.verificationId,
          ok: false,
          deviceId: null,
          error: sanitizeRemoteErrorMessage(error),
        },
        generation,
      );
    }
  }

  private async dispatch(command: RemoteCommand, generation: number): Promise<void> {
    try {
      const value = await this.daemon.handleCommand(command);
      this.sendFrame(
        {
          kind: 'result',
          result: remoteCommandSuccess(command.requestId, toJsonValue(value)),
        },
        generation,
      );
    } catch (error) {
      this.sendFrame(
        {
          kind: 'result',
          result: remoteCommandFailure(command.requestId, error),
        },
        generation,
      );
    }
  }

  private sendFrame(frame: TransportFrame, generation: number = this.generation): void {
    if (this.closed || this.generation !== generation) {
      return;
    }
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(serializeTransportFrame(frame));
  }
}

export async function attachDaemonToRelay(
  daemon: Daemon,
  url: string,
): Promise<DaemonRelayConnection> {
  return DaemonRelayConnection.connect(daemon, url);
}

function isMachineReplacedClose(code: number, reason: Buffer | string | undefined): boolean {
  if (reason === undefined) {
    return false;
  }
  const text = typeof reason === 'string' ? reason : Buffer.from(reason).toString('utf8');
  return code === MACHINE_REPLACED_CLOSE_CODE && text === MACHINE_REPLACED_CLOSE_REASON;
}

function readMachineId(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid machine URL');
  }
  const machineId = parsed.searchParams.get('machineId');
  if (machineId === null || machineId.length === 0) {
    throw new Error('machineId is required');
  }
  return machineId;
}

function toJsonValue(value: unknown): JsonValue | null {
  if (value === undefined) {
    return null;
  }
  return value as JsonValue;
}

async function waitForOpen(socket: DaemonSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }
  if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
    throw new Error('WebSocket closed');
  }
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve();
    });
    socket.once('error', (error) => {
      reject(error);
    });
    socket.once('close', () => {
      reject(new Error('WebSocket closed'));
    });
  });
}

async function waitForClose(socket: DaemonSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    socket.once('close', () => {
      resolve();
    });
  });
}

function readTextFrame(data: unknown, isBinary: boolean): string | undefined {
  if (isBinary) {
    return undefined;
  }
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  return undefined;
}
