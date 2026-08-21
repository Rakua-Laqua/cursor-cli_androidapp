import { randomBytes } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';

import {
  parseTransportFrame,
  remoteCommandFailure,
  remoteCommandSuccess,
  serializeTransportFrame,
  type AuthProofFrame,
  type PairFrame,
  type PairingVerifyFrame,
  type TransportFrame,
} from '@cursor-remote/protocol';

const RELAY_ERROR = {
  offline: 'Machine is offline',
  disconnected: 'Machine disconnected',
  replaced: 'Machine replaced',
  duplicate: 'Duplicate request id',
  closed: 'Relay server closed',
  unpaired: 'Device is not paired',
  authInProgress: 'Authentication already in progress',
} as const;

interface Connection {
  readonly role: 'machine' | 'client';
  readonly machineId: string;
  readonly socket: WebSocket;
  lastPongAt: number;
  authenticated: boolean;
  nonce: string | undefined;
  inflightVerificationId: string | undefined;
}

interface PendingRequest {
  readonly client: Connection;
  readonly machineId: string;
}

interface PendingVerification {
  readonly client: Connection;
  readonly machineId: string;
  readonly requestId: string;
  readonly verificationId: string;
}

export class RelayRouter {
  private readonly connections = new Map<WebSocket, Connection>();
  private readonly machines = new Map<string, Connection>();
  private readonly clients = new Map<string, Set<Connection>>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly verifications = new Map<string, PendingVerification>();

  attachMachine(machineId: string, socket: WebSocket): void {
    this.supersedeMachine(machineId);
    const connection: Connection = {
      role: 'machine',
      machineId,
      socket,
      lastPongAt: Date.now(),
      authenticated: true,
      nonce: undefined,
      inflightVerificationId: undefined,
    };
    this.bind(connection);
    this.machines.set(machineId, connection);
  }

  attachClient(machineId: string, socket: WebSocket): void {
    const nonce = randomBase64Url32();
    const connection: Connection = {
      role: 'client',
      machineId,
      socket,
      lastPongAt: Date.now(),
      authenticated: false,
      nonce,
      inflightVerificationId: undefined,
    };
    this.bind(connection);
    let group = this.clients.get(machineId);
    if (group === undefined) {
      group = new Set();
      this.clients.set(machineId, group);
    }
    group.add(connection);
    sendFrame(socket, { kind: 'auth_challenge', nonce });
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
    this.failMatchingVerifications(() => true, reason);
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

    let frame: TransportFrame;
    try {
      frame = parseTransportFrame(text);
    } catch {
      return;
    }

    if (connection.role === 'machine') {
      this.onMachineFrame(connection, frame);
      return;
    }
    this.onClientFrame(connection, frame);
  }

  private onClientFrame(connection: Connection, frame: TransportFrame): void {
    if (frame.kind === 'pair' || frame.kind === 'auth_proof') {
      this.onClientAuth(connection, frame);
      return;
    }
    if (frame.kind !== 'command') {
      return;
    }

    const requestId = frame.command.requestId;
    if (!connection.authenticated) {
      sendFrame(connection.socket, {
        kind: 'result',
        result: remoteCommandFailure(requestId, RELAY_ERROR.unpaired),
      });
      return;
    }
    if (this.requestIdInUse(requestId)) {
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

  private onClientAuth(connection: Connection, frame: PairFrame | AuthProofFrame): void {
    if (connection.authenticated || connection.nonce === undefined) {
      sendFrame(connection.socket, {
        kind: 'result',
        result: remoteCommandFailure(frame.requestId, RELAY_ERROR.unpaired),
      });
      return;
    }
    if (connection.inflightVerificationId !== undefined) {
      sendFrame(connection.socket, {
        kind: 'result',
        result: remoteCommandFailure(frame.requestId, RELAY_ERROR.authInProgress),
      });
      return;
    }
    if (this.requestIdInUse(frame.requestId)) {
      sendFrame(connection.socket, {
        kind: 'result',
        result: remoteCommandFailure(frame.requestId, RELAY_ERROR.duplicate),
      });
      return;
    }

    const machine = this.machines.get(connection.machineId);
    if (machine === undefined || machine.socket.readyState !== WebSocket.OPEN) {
      sendFrame(connection.socket, {
        kind: 'result',
        result: remoteCommandFailure(frame.requestId, RELAY_ERROR.offline),
      });
      return;
    }

    const verificationId = randomBase64Url32();
    const verifyFrame: PairingVerifyFrame =
      frame.kind === 'pair'
        ? {
            kind: 'pairing_verify',
            verificationId,
            operation: 'pair',
            machineId: connection.machineId,
            nonce: connection.nonce,
            token: frame.token,
            publicKey: frame.publicKey,
            signature: frame.signature,
          }
        : {
            kind: 'pairing_verify',
            verificationId,
            operation: 'auth',
            machineId: connection.machineId,
            nonce: connection.nonce,
            deviceId: frame.deviceId,
            signature: frame.signature,
          };

    connection.inflightVerificationId = verificationId;
    this.verifications.set(verificationId, {
      client: connection,
      machineId: connection.machineId,
      requestId: frame.requestId,
      verificationId,
    });
    sendFrame(machine.socket, verifyFrame);
  }

  private onMachineFrame(connection: Connection, frame: TransportFrame): void {
    if (this.machines.get(connection.machineId) !== connection) {
      return;
    }
    if (frame.kind === 'pairing_result') {
      this.onPairingResult(connection, frame);
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

  private onPairingResult(
    connection: Connection,
    frame: Extract<TransportFrame, { kind: 'pairing_result' }>,
  ): void {
    const pending = this.verifications.get(frame.verificationId);
    if (pending === undefined || pending.machineId !== connection.machineId) {
      return;
    }
    this.verifications.delete(frame.verificationId);
    if (pending.client.inflightVerificationId === frame.verificationId) {
      pending.client.inflightVerificationId = undefined;
    }
    if (!this.isLive(pending.client)) {
      return;
    }
    if (frame.ok) {
      pending.client.authenticated = true;
      pending.client.nonce = undefined;
    } else {
      this.issueChallenge(pending.client);
    }
    sendFrame(pending.client.socket, {
      kind: 'result',
      result: frame.ok
        ? remoteCommandSuccess(pending.requestId, { deviceId: frame.deviceId })
        : remoteCommandFailure(pending.requestId, frame.error ?? 'Pairing failed'),
    });
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
        this.failMatchingVerifications(
          (pending) => pending.machineId === connection.machineId,
          RELAY_ERROR.disconnected,
        );
        this.deauthenticateClients(connection.machineId);
      }
      return;
    }

    this.clients.get(connection.machineId)?.delete(connection);
    for (const [requestId, pending] of this.pending) {
      if (pending.client === connection) {
        this.pending.delete(requestId);
      }
    }
    for (const [verificationId, pending] of this.verifications) {
      if (pending.client === connection) {
        this.verifications.delete(verificationId);
      }
    }
  }

  private supersedeMachine(machineId: string): void {
    const existing = this.machines.get(machineId);
    if (existing === undefined) {
      return;
    }
    this.failMatchingPending((pending) => pending.machineId === machineId, RELAY_ERROR.replaced);
    this.failMatchingVerifications(
      (pending) => pending.machineId === machineId,
      RELAY_ERROR.replaced,
    );
    this.machines.delete(machineId);
    this.connections.delete(existing.socket);
    existing.socket.close(1000, RELAY_ERROR.replaced);
    this.deauthenticateClients(machineId);
  }

  private deauthenticateClients(machineId: string): void {
    const group = this.clients.get(machineId);
    if (group === undefined) {
      return;
    }
    for (const client of group) {
      this.issueChallenge(client);
    }
  }

  private issueChallenge(client: Connection): void {
    client.authenticated = false;
    client.inflightVerificationId = undefined;
    client.nonce = randomBase64Url32();
    sendFrame(client.socket, { kind: 'auth_challenge', nonce: client.nonce });
  }

  private broadcast(machineId: string, frame: TransportFrame): void {
    const group = this.clients.get(machineId);
    if (group === undefined) {
      return;
    }
    for (const client of group) {
      if (client.authenticated) {
        sendFrame(client.socket, frame);
      }
    }
  }

  private requestIdInUse(requestId: string): boolean {
    if (this.pending.has(requestId)) {
      return true;
    }
    for (const pending of this.verifications.values()) {
      if (pending.requestId === requestId) {
        return true;
      }
    }
    return false;
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

  private failMatchingVerifications(
    match: (pending: PendingVerification) => boolean,
    reason: string,
  ): void {
    for (const [verificationId, pending] of this.verifications) {
      if (!match(pending)) {
        continue;
      }
      this.verifications.delete(verificationId);
      if (pending.client.inflightVerificationId === verificationId) {
        pending.client.inflightVerificationId = undefined;
      }
      sendFrame(pending.client.socket, {
        kind: 'result',
        result: remoteCommandFailure(pending.requestId, reason),
      });
    }
  }
}

function sendFrame(socket: WebSocket, frame: TransportFrame): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(serializeTransportFrame(frame));
}

function randomBase64Url32(): string {
  return randomBytes(32).toString('base64url');
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
