import { WebSocket, type RawData } from 'ws';

import {
  parseRemoteFrame,
  remoteCommandFailure,
  serializeRemoteFrame,
  type RemoteFrame,
} from '@cursor-remote/protocol';

const RELAY_ERROR = {
  offline: 'Machine is offline',
  disconnected: 'Machine disconnected',
  replaced: 'Machine replaced',
  duplicate: 'Duplicate request id',
  closed: 'Relay server closed',
} as const;

interface Connection {
  readonly role: 'machine' | 'client';
  readonly machineId: string;
  readonly socket: WebSocket;
  lastPongAt: number;
}

interface PendingRequest {
  readonly client: Connection;
  readonly machineId: string;
}

export class RelayRouter {
  private readonly connections = new Map<WebSocket, Connection>();
  private readonly machines = new Map<string, Connection>();
  private readonly clients = new Map<string, Set<Connection>>();
  private readonly pending = new Map<string, PendingRequest>();

  attachMachine(machineId: string, socket: WebSocket): void {
    this.supersedeMachine(machineId);
    const connection: Connection = {
      role: 'machine',
      machineId,
      socket,
      lastPongAt: Date.now(),
    };
    this.bind(connection);
    this.machines.set(machineId, connection);
  }

  attachClient(machineId: string, socket: WebSocket): void {
    const connection: Connection = {
      role: 'client',
      machineId,
      socket,
      lastPongAt: Date.now(),
    };
    this.bind(connection);
    let group = this.clients.get(machineId);
    if (group === undefined) {
      group = new Set();
      this.clients.set(machineId, group);
    }
    group.add(connection);
  }

  heartbeat(staleTimeoutMs: number): void {
    const now = Date.now();
    for (const connection of [...this.connections.values()]) {
      if (now - connection.lastPongAt > staleTimeoutMs) {
        connection.socket.terminate();
        continue;
      }
      if (connection.socket.readyState === WebSocket.OPEN) {
        connection.socket.ping();
      }
    }
  }

  dispose(reason: string): void {
    this.failMatchingPending(() => true, reason);
    for (const connection of [...this.connections.values()]) {
      connection.socket.terminate();
    }
    this.connections.clear();
    this.machines.clear();
    this.clients.clear();
  }

  private bind(connection: Connection): void {
    const { socket } = connection;
    this.connections.set(socket, connection);
    socket.on('message', (data: RawData, isBinary: boolean) => {
      this.onMessage(connection, data, isBinary);
    });
    socket.on('close', () => {
      this.onClose(connection);
    });
    socket.on('error', () => {
      socket.terminate();
    });
    socket.on('pong', () => {
      connection.lastPongAt = Date.now();
    });
  }

  private isLive(connection: Connection): boolean {
    if (this.connections.get(connection.socket) !== connection) {
      return false;
    }
    if (connection.role === 'machine') {
      return this.machines.get(connection.machineId) === connection;
    }
    return this.clients.get(connection.machineId)?.has(connection) === true;
  }

  private onMessage(connection: Connection, data: RawData, isBinary: boolean): void {
    if (!this.isLive(connection)) {
      return;
    }

    const text = readTextFrame(data, isBinary);
    if (text === undefined) {
      return;
    }

    let frame: RemoteFrame;
    try {
      frame = parseRemoteFrame(text);
    } catch {
      return;
    }

    if (connection.role === 'machine') {
      this.onMachineFrame(connection, frame);
      return;
    }
    this.onClientFrame(connection, frame);
  }

  private onClientFrame(connection: Connection, frame: RemoteFrame): void {
    if (frame.kind !== 'command') {
      return;
    }

    const requestId = frame.command.requestId;
    if (this.pending.has(requestId)) {
      sendFrame(connection.socket, {
        kind: 'result',
        result: remoteCommandFailure(requestId, RELAY_ERROR.duplicate),
      });
      return;
    }

    const machine = this.machines.get(connection.machineId);
    if (machine === undefined || machine.socket.readyState !== WebSocket.OPEN) {
      sendFrame(connection.socket, {
        kind: 'result',
        result: remoteCommandFailure(requestId, RELAY_ERROR.offline),
      });
      return;
    }

    this.pending.set(requestId, { client: connection, machineId: connection.machineId });
    sendFrame(machine.socket, frame);
  }

  private onMachineFrame(connection: Connection, frame: RemoteFrame): void {
    if (this.machines.get(connection.machineId) !== connection) {
      return;
    }
    if (frame.kind === 'event') {
      this.broadcast(connection.machineId, frame);
      return;
    }
    if (frame.kind !== 'result') {
      return;
    }

    const pending = this.pending.get(frame.result.requestId);
    if (pending === undefined || pending.machineId !== connection.machineId) {
      return;
    }
    this.pending.delete(frame.result.requestId);
    sendFrame(pending.client.socket, frame);
  }

  private onClose(connection: Connection): void {
    if (this.connections.get(connection.socket) !== connection) {
      return;
    }
    this.connections.delete(connection.socket);

    if (connection.role === 'machine') {
      if (this.machines.get(connection.machineId) === connection) {
        this.machines.delete(connection.machineId);
        this.failMatchingPending(
          (pending) => pending.machineId === connection.machineId,
          RELAY_ERROR.disconnected,
        );
      }
      return;
    }

    this.clients.get(connection.machineId)?.delete(connection);
    for (const [requestId, pending] of this.pending) {
      if (pending.client === connection) {
        this.pending.delete(requestId);
      }
    }
  }

  private supersedeMachine(machineId: string): void {
    const existing = this.machines.get(machineId);
    if (existing === undefined) {
      return;
    }
    this.failMatchingPending((pending) => pending.machineId === machineId, RELAY_ERROR.replaced);
    this.machines.delete(machineId);
    this.connections.delete(existing.socket);
    existing.socket.close(1000, RELAY_ERROR.replaced);
  }

  private broadcast(machineId: string, frame: RemoteFrame): void {
    const group = this.clients.get(machineId);
    if (group === undefined) {
      return;
    }
    for (const client of group) {
      sendFrame(client.socket, frame);
    }
  }

  private failMatchingPending(match: (pending: PendingRequest) => boolean, reason: string): void {
    for (const [requestId, pending] of this.pending) {
      if (!match(pending)) {
        continue;
      }
      this.pending.delete(requestId);
      sendFrame(pending.client.socket, {
        kind: 'result',
        result: remoteCommandFailure(requestId, reason),
      });
    }
  }
}

function sendFrame(socket: WebSocket, frame: RemoteFrame): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(serializeRemoteFrame(frame));
}

function readTextFrame(data: RawData, isBinary: boolean): string | undefined {
  if (isBinary) {
    return undefined;
  }
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
    return Buffer.concat(data).toString('utf8');
  }
  return undefined;
}
