import { createHash, randomBytes } from 'node:crypto';

import {
  createPairingQrPayload,
  deviceIdFromPublicKey,
  parseBase64UrlBytes,
  parseP256PublicJwk,
  PAIRING_NONCE_BYTES,
  PAIRING_TOKEN_BYTES,
  type P256PublicJwk,
  type PairingQrPayload,
  verifyAuthProof,
  verifyPairProof,
} from '@cursor-remote/protocol';

import type { MetadataStore, PersistedDevice } from '../store/metadata-store.js';

export const DEFAULT_PAIRING_TOKEN_TTL_MS = 300_000;

export class PairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingError';
  }
}

export interface PairingManagerOptions {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly tokenTtlMs?: number;
}

export interface CreatedPairingToken {
  readonly token: string;
  readonly expiresAt: number;
}

export interface PairVerificationInput {
  readonly machineId: string;
  readonly nonce: string;
  readonly token: string;
  readonly publicKey: P256PublicJwk;
  readonly signature: string;
}

export interface AuthVerificationInput {
  readonly machineId: string;
  readonly nonce: string;
  readonly deviceId: string;
  readonly signature: string;
}

interface PendingToken {
  readonly machineId: string;
  readonly expiresAt: number;
}

export class PairingManager {
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly tokenTtlMs: number;
  private readonly pending = new Map<string, PendingToken>();
  private readonly memoryDevices: PersistedDevice[] = [];

  constructor(
    private readonly store: MetadataStore | undefined,
    options: PairingManagerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    const tokenTtlMs = options.tokenTtlMs ?? DEFAULT_PAIRING_TOKEN_TTL_MS;
    if (!Number.isSafeInteger(tokenTtlMs) || tokenTtlMs <= 0) {
      throw new PairingError('tokenTtlMs must be a positive safe integer.');
    }
    this.tokenTtlMs = tokenTtlMs;
  }

  createToken(machineId: string): CreatedPairingToken {
    if (typeof machineId !== 'string' || machineId.length === 0) {
      throw new PairingError('machineId must be a non-empty string.');
    }
    this.pruneExpired();
    const raw = Buffer.from(this.randomBytes(PAIRING_TOKEN_BYTES));
    if (raw.length !== PAIRING_TOKEN_BYTES) {
      throw new PairingError('Pairing token generator must return 32 bytes.');
    }
    const token = raw.toString('base64url');
    const expiresAt = this.now() + this.tokenTtlMs;
    this.pending.set(hashToken(raw), { machineId, expiresAt });
    return { token, expiresAt };
  }

  createQrPayload(input: {
    readonly relayUrl: string;
    readonly machineId: string;
  }): PairingQrPayload {
    const created = this.createToken(input.machineId);
    return createPairingQrPayload({
      relayUrl: input.relayUrl,
      machineId: input.machineId,
      token: created.token,
      expiresAt: created.expiresAt,
    });
  }

  verifyPair(input: PairVerificationInput): { readonly deviceId: string } {
    const tokenRaw = parseBase64UrlBytes(input.token, PAIRING_TOKEN_BYTES, 'token');
    const nonce = parseBase64UrlBytes(input.nonce, PAIRING_NONCE_BYTES, 'nonce').toString(
      'base64url',
    );
    const publicKey = parseP256PublicJwk(input.publicKey);
    const token = tokenRaw.toString('base64url');
    const tokenDigest = hashToken(tokenRaw);
    const pending = this.pending.get(tokenDigest);
    if (pending === undefined) {
      throw new PairingError('Unknown pairing token');
    }
    if (pending.machineId !== input.machineId) {
      throw new PairingError('Pairing token machine mismatch');
    }
    if (this.now() >= pending.expiresAt) {
      this.pending.delete(tokenDigest);
      throw new PairingError('Pairing token expired');
    }
    const ok = verifyPairProof(
      publicKey,
      {
        machineId: input.machineId,
        nonce,
        token,
        publicKey,
      },
      input.signature,
    );
    if (!ok) {
      throw new PairingError('Invalid pairing proof');
    }

    this.pending.delete(tokenDigest);
    const deviceId = deviceIdFromPublicKey(publicKey);
    this.persistDevice({
      deviceId,
      publicKey,
      createdAt: this.getDevice(deviceId)?.createdAt ?? new Date(this.now()).toISOString(),
    });
    return { deviceId };
  }

  verifyAuth(input: AuthVerificationInput): { readonly deviceId: string } {
    parseBase64UrlBytes(input.nonce, PAIRING_NONCE_BYTES, 'nonce');
    const device = this.getDevice(input.deviceId);
    if (device === undefined) {
      throw new PairingError('Unknown device');
    }
    const ok = verifyAuthProof(
      device.publicKey,
      {
        machineId: input.machineId,
        nonce: input.nonce,
        deviceId: device.deviceId,
      },
      input.signature,
    );
    if (!ok) {
      throw new PairingError('Invalid authentication proof');
    }
    return { deviceId: device.deviceId };
  }

  getDevice(deviceId: string): PersistedDevice | undefined {
    return this.devices().find((device) => device.deviceId === deviceId);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [digest, pending] of this.pending) {
      if (now >= pending.expiresAt) {
        this.pending.delete(digest);
      }
    }
  }

  private persistDevice(device: PersistedDevice): void {
    const next = [...this.devices().filter((item) => item.deviceId !== device.deviceId), device];
    if (this.store !== undefined) {
      this.store.writeDevices(next);
      return;
    }
    this.memoryDevices.splice(0, this.memoryDevices.length, ...next);
  }

  private devices(): readonly PersistedDevice[] {
    if (this.store !== undefined) {
      return this.store.getDevices();
    }
    return this.memoryDevices;
  }
}

function hashToken(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('base64url');
}

function defaultRandomBytes(size: number): Uint8Array {
  return randomBytes(size);
}
