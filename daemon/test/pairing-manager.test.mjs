import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  deviceIdFromPublicKey,
  generateP256KeyPair,
  parsePairingQrPayload,
  signAuthProof,
  signPairProof,
} from '@cursor-remote/protocol';

import {
  Daemon,
  DEFAULT_PAIRING_TOKEN_TTL_MS,
  METADATA_FILE_NAME,
  MetadataStore,
  PairingError,
  PairingManager,
} from '../dist/index.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-acp.mjs');

function mockLaunch() {
  return {
    command: process.execPath,
    args: [fixture],
  };
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pair-store-'));
}

function nonce32(fill) {
  return Buffer.alloc(32, fill).toString('base64url');
}

function sequentialRandom() {
  let n = 0;
  return (size) => {
    n += 1;
    const buf = Buffer.alloc(size, 0);
    buf[size - 1] = n;
    return buf;
  };
}

test('pairing token is one-use, expiry is enforced, and invalid proofs are not consumed', () => {
  assert.throws(() => new PairingManager(undefined, { tokenTtlMs: 0 }), /positive safe integer/);
  assert.throws(() => new PairingManager(undefined, { tokenTtlMs: 1.5 }), /positive safe integer/);

  let now = 1_000_000;
  const manager = new PairingManager(undefined, {
    now: () => now,
    randomBytes: sequentialRandom(),
    tokenTtlMs: DEFAULT_PAIRING_TOKEN_TTL_MS,
  });
  const keys = generateP256KeyPair();
  const other = generateP256KeyPair();
  const created = manager.createToken('pc-1');
  assert.equal(created.expiresAt, now + DEFAULT_PAIRING_TOKEN_TTL_MS);
  const nonce = nonce32(9);
  const pairInput = {
    machineId: 'pc-1',
    nonce,
    token: created.token,
    publicKey: keys.publicKey,
  };

  assert.throws(
    () =>
      manager.verifyPair({
        ...pairInput,
        signature: signPairProof(other.privateKey, pairInput),
      }),
    (error) => error instanceof PairingError && /Invalid pairing proof/.test(error.message),
  );

  const paired = manager.verifyPair({
    ...pairInput,
    signature: signPairProof(keys.privateKey, pairInput),
  });
  assert.equal(paired.deviceId, deviceIdFromPublicKey(keys.publicKey));
  assert.throws(
    () =>
      manager.verifyPair({
        ...pairInput,
        signature: signPairProof(keys.privateKey, pairInput),
      }),
    /Unknown pairing token/,
  );

  now = 5_000_000;
  const expired = manager.createToken('pc-1');
  now = expired.expiresAt;
  const expiredInput = {
    machineId: 'pc-1',
    nonce,
    token: expired.token,
    publicKey: keys.publicKey,
  };
  assert.throws(
    () =>
      manager.verifyPair({
        ...expiredInput,
        signature: signPairProof(keys.privateKey, expiredInput),
      }),
    /Pairing token expired/,
  );
  assert.throws(
    () =>
      manager.verifyPair({
        ...expiredInput,
        signature: signPairProof(keys.privateKey, expiredInput),
      }),
    /Unknown pairing token/,
  );

  now = expired.expiresAt + 1;
  const doomed = manager.createToken('pc-1');
  now = doomed.expiresAt;
  manager.createToken('pc-1');
  const doomedInput = {
    machineId: 'pc-1',
    nonce,
    token: doomed.token,
    publicKey: keys.publicKey,
  };
  assert.throws(
    () =>
      manager.verifyPair({
        ...doomedInput,
        signature: signPairProof(keys.privateKey, doomedInput),
      }),
    /Unknown pairing token/,
  );
});

test('persisted public devices authenticate after PairingManager reconstruction', () => {
  const stateDir = makeRoot();
  const filePath = path.join(stateDir, METADATA_FILE_NAME);
  const keys = generateP256KeyPair();
  const nonce = nonce32(11);
  const first = new PairingManager(new MetadataStore(filePath), {
    now: () => 1_700_000_000_000,
    randomBytes: sequentialRandom(),
  });
  const qr = first.createQrPayload({ relayUrl: 'ws://127.0.0.1:8787', machineId: 'pc-1' });
  assert.equal(parsePairingQrPayload(JSON.stringify(qr)).token, qr.token);
  const paired = first.verifyPair({
    machineId: 'pc-1',
    nonce,
    token: qr.token,
    publicKey: keys.publicKey,
    signature: signPairProof(keys.privateKey, {
      machineId: 'pc-1',
      nonce,
      token: qr.token,
      publicKey: keys.publicKey,
    }),
  });

  const raw = fs.readFileSync(filePath, 'utf8');
  assert.equal(raw.includes(qr.token), false);
  assert.equal(raw.includes(keys.privateKey.d), false);
  assert.equal(raw.includes(nonce), false);
  const stored = JSON.parse(raw);
  assert.equal(stored.version, 1);
  assert.equal(stored.devices[0].deviceId, paired.deviceId);
  assert.equal('d' in stored.devices[0].publicKey, false);

  const second = new PairingManager(new MetadataStore(filePath));
  assert.equal(second.getDevice(paired.deviceId)?.deviceId, paired.deviceId);
  assert.throws(
    () =>
      second.verifyPair({
        machineId: 'pc-1',
        nonce,
        token: qr.token,
        publicKey: keys.publicKey,
        signature: signPairProof(keys.privateKey, {
          machineId: 'pc-1',
          nonce,
          token: qr.token,
          publicKey: keys.publicKey,
        }),
      }),
    /Unknown pairing token/,
  );
  const replayNonce = nonce32(12);
  const replaySignature = signAuthProof(keys.privateKey, {
    machineId: 'pc-1',
    nonce: replayNonce,
    deviceId: paired.deviceId,
  });
  const freshNonce = nonce32(15);
  assert.throws(
    () =>
      second.verifyAuth({
        machineId: 'pc-1',
        nonce: freshNonce,
        deviceId: paired.deviceId,
        signature: replaySignature,
      }),
    /Invalid authentication proof/,
  );
  const wrong = generateP256KeyPair();
  assert.throws(
    () =>
      second.verifyAuth({
        machineId: 'pc-1',
        nonce: replayNonce,
        deviceId: paired.deviceId,
        signature: signAuthProof(wrong.privateKey, {
          machineId: 'pc-1',
          nonce: replayNonce,
          deviceId: paired.deviceId,
        }),
      }),
    /Invalid authentication proof/,
  );
  const authenticated = second.verifyAuth({
    machineId: 'pc-1',
    nonce: replayNonce,
    deviceId: paired.deviceId,
    signature: replaySignature,
  });
  assert.equal(authenticated.deviceId, paired.deviceId);
});

test('Daemon reconstructed from the same stateDir preserves device authentication', async () => {
  const stateDir = makeRoot();
  const allowedRoot = makeRoot();
  const keys = generateP256KeyPair();
  const nonce = nonce32(13);

  const first = await Daemon.start({
    acp: { ...mockLaunch(), shutdownTimeoutMs: 1000 },
    workspaces: { allowedRoots: [allowedRoot] },
    stateDir,
  });
  let deviceId;
  try {
    const created = first.pairing.createToken('pc-1');
    deviceId = first.pairing.verifyPair({
      machineId: 'pc-1',
      nonce,
      token: created.token,
      publicKey: keys.publicKey,
      signature: signPairProof(keys.privateKey, {
        machineId: 'pc-1',
        nonce,
        token: created.token,
        publicKey: keys.publicKey,
      }),
    }).deviceId;
  } finally {
    await first.stop();
  }

  const second = await Daemon.start({
    acp: { ...mockLaunch(), shutdownTimeoutMs: 1000 },
    workspaces: { allowedRoots: [allowedRoot] },
    stateDir,
  });
  try {
    const authNonce = nonce32(14);
    const authenticated = second.pairing.verifyAuth({
      machineId: 'pc-1',
      nonce: authNonce,
      deviceId,
      signature: signAuthProof(keys.privateKey, {
        machineId: 'pc-1',
        nonce: authNonce,
        deviceId,
      }),
    });
    assert.equal(authenticated.deviceId, deviceId);
  } finally {
    await second.stop();
  }
});
