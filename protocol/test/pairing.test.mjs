import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import {
  AUTH_PROOF_DOMAIN,
  canonicalAuthProofBytes,
  canonicalPairProofBytes,
  createPairingQrPayload,
  deviceIdFromPublicKey,
  generateP256KeyPair,
  PAIR_PROOF_DOMAIN,
  parsePairingQrPayload,
  parseRemoteFrame,
  parseTransportFrame,
  ProtocolParseError,
  serializePairingQrPayload,
  serializeRemoteFrame,
  serializeTransportFrame,
  signAuthProof,
  signPairProof,
  verifyAuthProof,
  verifyPairProof,
} from '../dist/index.js';

function token32(fill = 1) {
  return Buffer.alloc(32, fill).toString('base64url');
}

test('QR payload round-trips and rejects malformed origins and extra fields', () => {
  const payload = createPairingQrPayload({
    relayUrl: 'ws://127.0.0.1:8787/',
    machineId: 'pc-1',
    token: token32(3),
    expiresAt: 1_700_000_000_000,
  });
  assert.equal(payload.v, 1);
  assert.equal(payload.relayUrl, 'ws://127.0.0.1:8787');
  const parsed = parsePairingQrPayload(serializePairingQrPayload(payload));
  assert.deepEqual(parsed, payload);

  assert.throws(() => parsePairingQrPayload(JSON.stringify({ ...payload, v: 2 })), /v must be 1/);
  assert.throws(
    () => parsePairingQrPayload(JSON.stringify({ ...payload, relayUrl: 'http://127.0.0.1:8787' })),
    /ws or wss origin/,
  );
  assert.throws(
    () =>
      parsePairingQrPayload(
        JSON.stringify({ ...payload, relayUrl: 'ws://user:pass@127.0.0.1:8787' }),
      ),
    /credentials/,
  );
  assert.throws(
    () =>
      parsePairingQrPayload(
        JSON.stringify({ ...payload, relayUrl: 'ws://127.0.0.1:8787/client?machineId=pc-1' }),
      ),
    /query or fragment|origin/,
  );
  assert.throws(
    () =>
      parsePairingQrPayload(JSON.stringify({ ...payload, relayUrl: 'ws://127.0.0.1:8787/#frag' })),
    /query or fragment/,
  );
  assert.throws(
    () => parsePairingQrPayload(JSON.stringify({ ...payload, extra: true })),
    /unexpected or missing fields/,
  );
});

test('P-256 JWK validation, device id, and pair/auth proofs use DER signatures', () => {
  const keys = generateP256KeyPair();
  const other = generateP256KeyPair();
  const nonce = token32(4);
  const token = token32(5);
  const pairInput = {
    machineId: 'pc-1',
    nonce,
    token,
    publicKey: keys.publicKey,
  };
  const canonical = canonicalPairProofBytes(pairInput).toString('utf8');
  assert.equal(canonical.startsWith('['), true);
  assert.equal(JSON.parse(canonical)[0], PAIR_PROOF_DOMAIN);
  assert.deepEqual(JSON.parse(canonical)[4], keys.publicKey);

  const signature = signPairProof(keys.privateKey, pairInput);
  const der = Buffer.from(signature, 'base64url');
  assert.equal(der[0], 0x30);
  assert.equal(verifyPairProof(keys.publicKey, pairInput, signature), true);
  assert.equal(verifyPairProof(other.publicKey, pairInput, signature), false);
  assert.equal(
    verifyPairProof(keys.publicKey, pairInput, signPairProof(other.privateKey, pairInput)),
    false,
  );

  const deviceId = deviceIdFromPublicKey(keys.publicKey);
  const authInput = { machineId: 'pc-1', nonce, deviceId };
  assert.equal(
    JSON.parse(canonicalAuthProofBytes(authInput).toString('utf8'))[0],
    AUTH_PROOF_DOMAIN,
  );
  const authSignature = signAuthProof(keys.privateKey, authInput);
  assert.equal(verifyAuthProof(keys.publicKey, authInput, authSignature), true);
  assert.equal(verifyAuthProof(keys.publicKey, authInput, signature), false);
  assert.equal(verifyAuthProof(other.publicKey, authInput, authSignature), false);
  const otherNonce = token32(16);
  assert.equal(
    verifyAuthProof(keys.publicKey, { ...authInput, nonce: otherNonce }, authSignature),
    false,
  );

  assert.throws(
    () =>
      parseTransportFrame(
        JSON.stringify({
          kind: 'pair',
          requestId: 'req-1',
          token,
          publicKey: { ...keys.publicKey, d: keys.privateKey.d },
          signature,
        }),
      ),
    ProtocolParseError,
  );
});

test('transport parser preserves RemoteFrame behavior and strictly parses pairing frames', () => {
  const command = {
    requestId: 'req_frame',
    sessionId: 'remote_sess_123',
    timestamp: '2026-08-17T07:00:03+09:00',
    type: 'workspace.list',
    payload: {},
  };
  const json = serializeRemoteFrame({ kind: 'command', command });
  assert.deepEqual(parseTransportFrame(json), parseRemoteFrame(json));
  assert.deepEqual(parseTransportFrame(serializeTransportFrame({ kind: 'command', command })), {
    kind: 'command',
    command,
  });

  const keys = generateP256KeyPair();
  const nonce = token32(6);
  const token = token32(7);
  const signature = signPairProof(keys.privateKey, {
    machineId: 'pc-1',
    nonce,
    token,
    publicKey: keys.publicKey,
  });
  const pair = {
    kind: 'pair',
    requestId: 'pair-1',
    token,
    publicKey: keys.publicKey,
    signature,
  };
  const parsedPair = parseTransportFrame(serializeTransportFrame(pair));
  assert.deepEqual(parsedPair, pair);
  assert.throws(() => parseRemoteFrame(serializeTransportFrame(pair)), /kind must be/);
  assert.throws(
    () => parseTransportFrame(JSON.stringify({ ...pair, extra: 1 })),
    /unexpected or missing fields/,
  );

  const challenge = { kind: 'auth_challenge', nonce };
  assert.deepEqual(parseTransportFrame(serializeTransportFrame(challenge)), challenge);

  const verify = {
    kind: 'pairing_verify',
    verificationId: token32(8),
    operation: 'pair',
    machineId: 'pc-1',
    nonce,
    token,
    publicKey: keys.publicKey,
    signature,
  };
  assert.deepEqual(parseTransportFrame(serializeTransportFrame(verify)), verify);
  assert.throws(
    () => parseTransportFrame(JSON.stringify({ ...verify, deviceId: 'nope' })),
    /unexpected or missing fields/,
  );
});
