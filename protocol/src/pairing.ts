import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  type JsonWebKey,
} from 'node:crypto';

import {
  parseRemoteFrame,
  ProtocolParseError,
  serializeRemoteFrame,
  type RemoteFrame,
} from './protocol.js';

export const PAIRING_QR_VERSION = 1;
export const PAIR_PROOF_DOMAIN = 'cursor-remote.pair.v1';
export const AUTH_PROOF_DOMAIN = 'cursor-remote.auth.v1';
export const PAIRING_TOKEN_BYTES = 32;
export const PAIRING_NONCE_BYTES = 32;
export const P256_COORDINATE_BYTES = 32;

export interface P256PublicJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
}

export interface P256PrivateJwk extends P256PublicJwk {
  readonly d: string;
}

export interface PairingQrPayload {
  readonly v: 1;
  readonly relayUrl: string;
  readonly machineId: string;
  readonly token: string;
  readonly expiresAt: number;
}

export interface PairProofInput {
  readonly machineId: string;
  readonly nonce: string;
  readonly token: string;
  readonly publicKey: P256PublicJwk;
}

export interface AuthProofInput {
  readonly machineId: string;
  readonly nonce: string;
  readonly deviceId: string;
}

export interface AuthChallengeFrame {
  readonly kind: 'auth_challenge';
  readonly nonce: string;
}

export interface PairFrame {
  readonly kind: 'pair';
  readonly requestId: string;
  readonly token: string;
  readonly publicKey: P256PublicJwk;
  readonly signature: string;
}

export interface AuthProofFrame {
  readonly kind: 'auth_proof';
  readonly requestId: string;
  readonly deviceId: string;
  readonly signature: string;
}

export interface PairingVerifyPairFrame {
  readonly kind: 'pairing_verify';
  readonly verificationId: string;
  readonly operation: 'pair';
  readonly machineId: string;
  readonly nonce: string;
  readonly token: string;
  readonly publicKey: P256PublicJwk;
  readonly signature: string;
}

export interface PairingVerifyAuthFrame {
  readonly kind: 'pairing_verify';
  readonly verificationId: string;
  readonly operation: 'auth';
  readonly machineId: string;
  readonly nonce: string;
  readonly deviceId: string;
  readonly signature: string;
}

export type PairingVerifyFrame = PairingVerifyPairFrame | PairingVerifyAuthFrame;

export interface PairingResultFrame {
  readonly kind: 'pairing_result';
  readonly verificationId: string;
  readonly ok: boolean;
  readonly deviceId: string | null;
  readonly error: string | null;
}

export interface TransportRegisterFrame {
  readonly kind: 'transport_register';
  readonly requestId: string;
  readonly fcmToken: string | null;
  readonly appForeground: boolean;
}

export type TransportFrame =
  | RemoteFrame
  | AuthChallengeFrame
  | PairFrame
  | AuthProofFrame
  | PairingVerifyFrame
  | PairingResultFrame
  | TransportRegisterFrame;

const TRANSPORT_REGISTER_MAX_BYTES = 8192;
const TRANSPORT_REGISTER_REQUEST_ID_MAX = 128;
const FCM_TOKEN_MAX_CODE_UNITS = 4096;
const FCM_TOKEN_CHARS = /^[A-Za-z0-9_.:-]+$/;

export function parsePairingQrPayload(json: string): PairingQrPayload {
  return parsePairingQrRecord(JSON.parse(json));
}

export function serializePairingQrPayload(payload: PairingQrPayload): string {
  return JSON.stringify(parsePairingQrRecord(payload));
}

export function createPairingQrPayload(input: {
  readonly relayUrl: string;
  readonly machineId: string;
  readonly token: string;
  readonly expiresAt: number;
}): PairingQrPayload {
  return parsePairingQrRecord({
    v: PAIRING_QR_VERSION,
    relayUrl: input.relayUrl,
    machineId: input.machineId,
    token: input.token,
    expiresAt: input.expiresAt,
  });
}

export function parseRelayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProtocolParseError('relayUrl must be a ws or wss origin.');
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new ProtocolParseError('relayUrl must be a ws or wss origin.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ProtocolParseError('relayUrl must not include credentials.');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ProtocolParseError('relayUrl must not include query or fragment.');
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new ProtocolParseError('relayUrl must be a ws or wss origin.');
  }
  if (url.hostname.length === 0) {
    throw new ProtocolParseError('relayUrl must be a ws or wss origin.');
  }
  return `${url.protocol}//${url.host}`;
}

export function parseP256PublicJwk(value: unknown): P256PublicJwk {
  if (!isRecord(value)) {
    throw new ProtocolParseError('publicKey must be a JSON object.');
  }
  assertExactKeys(value, ['kty', 'crv', 'x', 'y']);
  if (value.kty !== 'EC') {
    throw new ProtocolParseError('publicKey.kty must be EC.');
  }
  if (value.crv !== 'P-256') {
    throw new ProtocolParseError('publicKey.crv must be P-256.');
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    x: parseBase64UrlBytes(value.x, P256_COORDINATE_BYTES, 'publicKey.x').toString('base64url'),
    y: parseBase64UrlBytes(value.y, P256_COORDINATE_BYTES, 'publicKey.y').toString('base64url'),
  };
}

export function parseP256PrivateJwk(value: unknown): P256PrivateJwk {
  if (!isRecord(value)) {
    throw new ProtocolParseError('privateKey must be a JSON object.');
  }
  assertExactKeys(value, ['kty', 'crv', 'x', 'y', 'd']);
  const publicKey = parseP256PublicJwk({
    kty: value.kty,
    crv: value.crv,
    x: value.x,
    y: value.y,
  });
  return {
    ...publicKey,
    d: parseBase64UrlBytes(value.d, P256_COORDINATE_BYTES, 'privateKey.d').toString('base64url'),
  };
}

export function generateP256KeyPair(): {
  readonly publicKey: P256PublicJwk;
  readonly privateKey: P256PrivateJwk;
} {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateJwk = pair.privateKey.export({ format: 'jwk' });
  const publicKey = parseP256PublicJwk({
    kty: 'EC',
    crv: 'P-256',
    x: padCoordinate(privateJwk.x, 'publicKey.x'),
    y: padCoordinate(privateJwk.y, 'publicKey.y'),
  });
  return {
    publicKey,
    privateKey: parseP256PrivateJwk({
      ...publicKey,
      d: padCoordinate(privateJwk.d, 'privateKey.d'),
    }),
  };
}

export function deviceIdFromPublicKey(publicKey: P256PublicJwk): string {
  const canonical = parseP256PublicJwk(publicKey);
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('base64url');
}

export function canonicalPairProofBytes(input: PairProofInput): Buffer {
  const publicKey = parseP256PublicJwk(input.publicKey);
  requireNonEmptyString(input.machineId, 'machineId');
  parseBase64UrlBytes(input.nonce, PAIRING_NONCE_BYTES, 'nonce');
  parseBase64UrlBytes(input.token, PAIRING_TOKEN_BYTES, 'token');
  return Buffer.from(
    JSON.stringify([PAIR_PROOF_DOMAIN, input.machineId, input.nonce, input.token, publicKey]),
    'utf8',
  );
}

export function canonicalAuthProofBytes(input: AuthProofInput): Buffer {
  requireNonEmptyString(input.machineId, 'machineId');
  requireNonEmptyString(input.deviceId, 'deviceId');
  parseBase64UrlBytes(input.nonce, PAIRING_NONCE_BYTES, 'nonce');
  return Buffer.from(
    JSON.stringify([AUTH_PROOF_DOMAIN, input.machineId, input.nonce, input.deviceId]),
    'utf8',
  );
}

export function signPairProof(privateKey: P256PrivateJwk, input: PairProofInput): string {
  return signSha256EcdsaDer(privateKey, canonicalPairProofBytes(input));
}

export function verifyPairProof(
  publicKey: P256PublicJwk,
  input: PairProofInput,
  signature: string,
): boolean {
  return verifySha256EcdsaDer(publicKey, canonicalPairProofBytes(input), signature);
}

export function signAuthProof(privateKey: P256PrivateJwk, input: AuthProofInput): string {
  return signSha256EcdsaDer(privateKey, canonicalAuthProofBytes(input));
}

export function verifyAuthProof(
  publicKey: P256PublicJwk,
  input: AuthProofInput,
  signature: string,
): boolean {
  return verifySha256EcdsaDer(publicKey, canonicalAuthProofBytes(input), signature);
}

export function signSha256EcdsaDer(privateKey: P256PrivateJwk, bytes: Uint8Array): string {
  const key = createPrivateKey({ key: toPrivateJsonWebKey(privateKey), format: 'jwk' });
  const signer = createSign('SHA256');
  signer.update(Buffer.from(bytes));
  signer.end();
  return signer.sign(key).toString('base64url');
}

export function verifySha256EcdsaDer(
  publicKey: P256PublicJwk,
  bytes: Uint8Array,
  signature: string,
): boolean {
  try {
    const key = createPublicKey({ key: toPublicJsonWebKey(publicKey), format: 'jwk' });
    const der = parseBase64Url(signature, 'signature');
    const verifier = createVerify('SHA256');
    verifier.update(Buffer.from(bytes));
    verifier.end();
    return verifier.verify(key, der);
  } catch {
    return false;
  }
}

function toPublicJsonWebKey(publicKey: P256PublicJwk): JsonWebKey {
  const parsed = parseP256PublicJwk(publicKey);
  const jwk: JsonWebKey = {
    kty: parsed.kty,
    crv: parsed.crv,
    x: parsed.x,
    y: parsed.y,
  };
  return jwk;
}

function toPrivateJsonWebKey(privateKey: P256PrivateJwk): JsonWebKey {
  const parsed = parseP256PrivateJwk(privateKey);
  const jwk: JsonWebKey = {
    kty: parsed.kty,
    crv: parsed.crv,
    x: parsed.x,
    y: parsed.y,
    d: parsed.d,
  };
  return jwk;
}

export function parseTransportFrame(json: string): TransportFrame {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new ProtocolParseError('Frame must be a JSON object.');
  }

  const kind = parsed.kind;
  if (kind === 'command' || kind === 'event' || kind === 'result') {
    return parseRemoteFrame(json);
  }
  if (kind === 'auth_challenge') {
    return parseAuthChallengeFrame(parsed);
  }
  if (kind === 'pair') {
    return parsePairFrame(parsed);
  }
  if (kind === 'auth_proof') {
    return parseAuthProofFrame(parsed);
  }
  if (kind === 'pairing_verify') {
    return parsePairingVerifyFrame(parsed);
  }
  if (kind === 'pairing_result') {
    return parsePairingResultFrame(parsed);
  }
  if (kind === 'transport_register') {
    if (Buffer.byteLength(json, 'utf8') > TRANSPORT_REGISTER_MAX_BYTES) {
      throw new ProtocolParseError('transport_register exceeds 8192 bytes.');
    }
    return parseTransportRegisterFrame(parsed);
  }

  throw new ProtocolParseError(
    'kind must be command, event, result, auth_challenge, pair, auth_proof, pairing_verify, pairing_result, or transport_register.',
  );
}

export function serializeTransportFrame(frame: TransportFrame): string {
  if (frame.kind === 'command' || frame.kind === 'event' || frame.kind === 'result') {
    return serializeRemoteFrame(frame);
  }
  if (frame.kind === 'auth_challenge') {
    return JSON.stringify(parseAuthChallengeFrame(frame));
  }
  if (frame.kind === 'pair') {
    return JSON.stringify(parsePairFrame(frame));
  }
  if (frame.kind === 'auth_proof') {
    return JSON.stringify(parseAuthProofFrame(frame));
  }
  if (frame.kind === 'pairing_verify') {
    return JSON.stringify(parsePairingVerifyFrame(frame));
  }
  if (frame.kind === 'pairing_result') {
    return JSON.stringify(parsePairingResultFrame(frame));
  }
  const json = JSON.stringify(parseTransportRegisterFrame(frame));
  if (Buffer.byteLength(json, 'utf8') > TRANSPORT_REGISTER_MAX_BYTES) {
    throw new ProtocolParseError('transport_register exceeds 8192 bytes.');
  }
  return json;
}

export function parseBase64UrlBytes(value: unknown, size: number, fieldName: string): Buffer {
  const raw = parseBase64Url(value, fieldName);
  if (raw.length !== size) {
    throw new ProtocolParseError(`${fieldName} must be ${size} bytes encoded as base64url.`);
  }
  return raw;
}

function parsePairingQrRecord(value: unknown): PairingQrPayload {
  if (!isRecord(value)) {
    throw new ProtocolParseError('Pairing QR payload must be a JSON object.');
  }
  assertExactKeys(value, ['v', 'relayUrl', 'machineId', 'token', 'expiresAt']);
  if (value.v !== PAIRING_QR_VERSION) {
    throw new ProtocolParseError('v must be 1.');
  }
  if (
    typeof value.expiresAt !== 'number' ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= 0
  ) {
    throw new ProtocolParseError('expiresAt must be a positive safe integer.');
  }
  return {
    v: PAIRING_QR_VERSION,
    relayUrl: parseRelayOrigin(requireNonEmptyString(value.relayUrl, 'relayUrl')),
    machineId: requireNonEmptyString(value.machineId, 'machineId'),
    token: parseBase64UrlBytes(value.token, PAIRING_TOKEN_BYTES, 'token').toString('base64url'),
    expiresAt: value.expiresAt,
  };
}

function parseAuthChallengeFrame(
  value: Record<string, unknown> | AuthChallengeFrame,
): AuthChallengeFrame {
  const record = asRecord(value);
  assertExactKeys(record, ['kind', 'nonce']);
  return {
    kind: 'auth_challenge',
    nonce: parseBase64UrlBytes(record.nonce, PAIRING_NONCE_BYTES, 'nonce').toString('base64url'),
  };
}

function parsePairFrame(value: Record<string, unknown> | PairFrame): PairFrame {
  const record = asRecord(value);
  assertExactKeys(record, ['kind', 'requestId', 'token', 'publicKey', 'signature']);
  return {
    kind: 'pair',
    requestId: requireNonEmptyString(record.requestId, 'requestId'),
    token: parseBase64UrlBytes(record.token, PAIRING_TOKEN_BYTES, 'token').toString('base64url'),
    publicKey: parseP256PublicJwk(record.publicKey),
    signature: parseBase64Url(record.signature, 'signature').toString('base64url'),
  };
}

function parseAuthProofFrame(value: Record<string, unknown> | AuthProofFrame): AuthProofFrame {
  const record = asRecord(value);
  assertExactKeys(record, ['kind', 'requestId', 'deviceId', 'signature']);
  return {
    kind: 'auth_proof',
    requestId: requireNonEmptyString(record.requestId, 'requestId'),
    deviceId: requireNonEmptyString(record.deviceId, 'deviceId'),
    signature: parseBase64Url(record.signature, 'signature').toString('base64url'),
  };
}

function parsePairingVerifyFrame(
  value: Record<string, unknown> | PairingVerifyFrame,
): PairingVerifyFrame {
  const record = asRecord(value);
  const operation = record.operation;
  if (operation === 'pair') {
    assertExactKeys(record, [
      'kind',
      'verificationId',
      'operation',
      'machineId',
      'nonce',
      'token',
      'publicKey',
      'signature',
    ]);
    return {
      kind: 'pairing_verify',
      verificationId: requireNonEmptyString(record.verificationId, 'verificationId'),
      operation: 'pair',
      machineId: requireNonEmptyString(record.machineId, 'machineId'),
      nonce: parseBase64UrlBytes(record.nonce, PAIRING_NONCE_BYTES, 'nonce').toString('base64url'),
      token: parseBase64UrlBytes(record.token, PAIRING_TOKEN_BYTES, 'token').toString('base64url'),
      publicKey: parseP256PublicJwk(record.publicKey),
      signature: parseBase64Url(record.signature, 'signature').toString('base64url'),
    };
  }
  if (operation === 'auth') {
    assertExactKeys(record, [
      'kind',
      'verificationId',
      'operation',
      'machineId',
      'nonce',
      'deviceId',
      'signature',
    ]);
    return {
      kind: 'pairing_verify',
      verificationId: requireNonEmptyString(record.verificationId, 'verificationId'),
      operation: 'auth',
      machineId: requireNonEmptyString(record.machineId, 'machineId'),
      nonce: parseBase64UrlBytes(record.nonce, PAIRING_NONCE_BYTES, 'nonce').toString('base64url'),
      deviceId: requireNonEmptyString(record.deviceId, 'deviceId'),
      signature: parseBase64Url(record.signature, 'signature').toString('base64url'),
    };
  }
  throw new ProtocolParseError('operation must be pair or auth.');
}

function parsePairingResultFrame(
  value: Record<string, unknown> | PairingResultFrame,
): PairingResultFrame {
  const record = asRecord(value);
  assertExactKeys(record, ['kind', 'verificationId', 'ok', 'deviceId', 'error']);
  const verificationId = requireNonEmptyString(record.verificationId, 'verificationId');
  if (typeof record.ok !== 'boolean') {
    throw new ProtocolParseError('ok must be a boolean.');
  }
  const deviceId = record.deviceId;
  const error = record.error;
  if (deviceId !== null && (typeof deviceId !== 'string' || deviceId.length === 0)) {
    throw new ProtocolParseError('deviceId must be a non-empty string or null.');
  }
  if (error !== null && (typeof error !== 'string' || error.length === 0)) {
    throw new ProtocolParseError('error must be a non-empty string or null.');
  }
  if (record.ok) {
    if (error !== null) {
      throw new ProtocolParseError('successful pairing_result must have error null.');
    }
    if (deviceId === null) {
      throw new ProtocolParseError('successful pairing_result must have a deviceId.');
    }
    return { kind: 'pairing_result', verificationId, ok: true, deviceId, error: null };
  }
  if (deviceId !== null) {
    throw new ProtocolParseError('failed pairing_result must have deviceId null.');
  }
  if (error === null) {
    throw new ProtocolParseError('failed pairing_result must have a non-empty error.');
  }
  return { kind: 'pairing_result', verificationId, ok: false, deviceId: null, error };
}

function parseTransportRegisterFrame(
  value: Record<string, unknown> | TransportRegisterFrame,
): TransportRegisterFrame {
  const record = asRecord(value);
  assertExactKeys(record, ['kind', 'requestId', 'fcmToken', 'appForeground']);
  const requestId = requireNonEmptyString(record.requestId, 'requestId');
  if (requestId.length > TRANSPORT_REGISTER_REQUEST_ID_MAX) {
    throw new ProtocolParseError('requestId must be at most 128 characters.');
  }
  if (typeof record.appForeground !== 'boolean') {
    throw new ProtocolParseError('appForeground must be a boolean.');
  }
  return {
    kind: 'transport_register',
    requestId,
    fcmToken: parseFcmToken(record.fcmToken),
    appForeground: record.appForeground,
  };
}

function parseFcmToken(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProtocolParseError('fcmToken must be a non-empty string or null.');
  }
  if (value.length > FCM_TOKEN_MAX_CODE_UNITS) {
    throw new ProtocolParseError('fcmToken must be at most 4096 characters.');
  }
  if (!FCM_TOKEN_CHARS.test(value)) {
    throw new ProtocolParseError('fcmToken contains invalid characters.');
  }
  return value;
}

function parseBase64Url(value: unknown, fieldName: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ProtocolParseError(`${fieldName} must be base64url.`);
  }
  const raw = Buffer.from(value, 'base64url');
  if (raw.length === 0 || raw.toString('base64url') !== value) {
    throw new ProtocolParseError(`${fieldName} must be base64url.`);
  }
  return raw;
}

function padCoordinate(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProtocolParseError(`${fieldName} must be base64url.`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.length > P256_COORDINATE_BYTES) {
    throw new ProtocolParseError(
      `${fieldName} must be ${P256_COORDINATE_BYTES} bytes encoded as base64url.`,
    );
  }
  if (decoded.length === P256_COORDINATE_BYTES) {
    return decoded.toString('base64url');
  }
  const padded = Buffer.alloc(P256_COORDINATE_BYTES);
  decoded.copy(padded, P256_COORDINATE_BYTES - decoded.length);
  return padded.toString('base64url');
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProtocolParseError(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new ProtocolParseError('unexpected or missing fields.');
  }
}

function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
