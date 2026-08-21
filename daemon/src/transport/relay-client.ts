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
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  once(event: 'open', listener: () => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'close', listener: () => void): void;
}

const WebSocket = createRequire(import.meta.url)('ws') as WsConstructor;

export class DaemonRelayConnection {
  private closed = false;

  private constructor(
    private readonly daemon: Daemon,
    private readonly socket: DaemonSocket,
    private readonly stopEvents: () => void,
    private readonly machineId: string,
  ) {
    socket.on('message', (data, isBinary) => {
      this.onMessage(data, isBinary);
    });
    socket.on('close', () => {
      this.shutdownLocal();
    });
    socket.on('error', () => {
      socket.close();
    });
  }

  static async connect(daemon: Daemon, url: string): Promise<DaemonRelayConnection> {
    const machineId = readMachineId(url);
    const socket = new WebSocket(url);
    const stopEvents = daemon.onEvent((event) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(serializeTransportFrame({ kind: 'event', event }));
    });
    const connection = new DaemonRelayConnection(daemon, socket, stopEvents, machineId);
    try {
      await waitForOpen(socket);
    } catch (error) {
      await connection.close();
      throw error;
    }
    return connection;
  }

  async close(): Promise<void> {
    this.shutdownLocal();
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    if (this.socket.readyState !== WebSocket.CLOSING) {
      this.socket.close();
    }
    await waitForClose(this.socket);
  }

  private shutdownLocal(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopEvents();
  }

  private onMessage(data: unknown, isBinary: boolean): void {
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
      this.dispatchPairingVerify(frame);
      return;
    }
    if (frame.kind !== 'command') {
      return;
    }
    void this.dispatch(frame.command);
  }

  private dispatchPairingVerify(frame: PairingVerifyFrame): void {
    if (frame.machineId !== this.machineId) {
      this.sendFrame({
        kind: 'pairing_result',
        verificationId: frame.verificationId,
        ok: false,
        deviceId: null,
        error: 'Machine mismatch',
      });
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
      this.sendFrame({
        kind: 'pairing_result',
        verificationId: frame.verificationId,
        ok: true,
        deviceId,
        error: null,
      });
    } catch (error) {
      this.sendFrame({
        kind: 'pairing_result',
        verificationId: frame.verificationId,
        ok: false,
        deviceId: null,
        error: sanitizeRemoteErrorMessage(error),
      });
    }
  }

  private async dispatch(command: RemoteCommand): Promise<void> {
    try {
      const value = await this.daemon.handleCommand(command);
      this.sendFrame({
        kind: 'result',
        result: remoteCommandSuccess(command.requestId, toJsonValue(value)),
      });
    } catch (error) {
      this.sendFrame({
        kind: 'result',
        result: remoteCommandFailure(command.requestId, error),
      });
    }
  }

  private sendFrame(frame: TransportFrame): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(serializeTransportFrame(frame));
  }
}

export async function attachDaemonToRelay(
  daemon: Daemon,
  url: string,
): Promise<DaemonRelayConnection> {
  return DaemonRelayConnection.connect(daemon, url);
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
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve();
    });
    socket.once('error', (error) => {
      reject(error);
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
