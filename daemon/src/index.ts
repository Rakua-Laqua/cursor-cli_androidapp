import { EVENT_TYPES } from '@cursor-remote/protocol';

export { Daemon, type DaemonAcpOptions, type DaemonStartOptions } from './daemon.js';
export { attachDaemonToRelay, DaemonRelayConnection } from './transport/relay-client.js';
export {
  DEFAULT_PAIRING_TOKEN_TTL_MS,
  PairingError,
  PairingManager,
  type AuthVerificationInput,
  type CreatedPairingToken,
  type PairingManagerOptions,
  type PairVerificationInput,
} from './pairing/pairing-manager.js';
export { AcpSessionAdapter, type CreateSessionInput } from './session/session-adapter.js';
export { mapAcpSessionUpdate, type MappedSessionEvent } from './session/map-session-update.js';
export {
  MAX_PERMISSION_COMMAND_LENGTH,
  MAX_PERMISSION_KIND_LENGTH,
  PERMISSION_TIMEOUT_MS,
  PermissionBridge,
  type PermissionBridgeOptions,
  type PermissionDecision,
  type PermissionRequestedNotice,
  type PermissionResolvedNotice,
} from './permissions/permission-bridge.js';
export {
  WorkspaceManager,
  WorkspaceNotFoundError,
  type WorkspaceManagerOptions,
} from './workspace/workspace-manager.js';
export {
  WorkspaceNotAllowedError,
  WorkspacePathError,
  assertDirectoryAllowed,
  canonicalizeExistingPath,
  canonicalizeRoot,
  findAllowedRoot,
  freezeAllowedRoot,
  isPathInsideRoot,
} from './workspace/path-guard.js';
export {
  METADATA_FILE_NAME,
  METADATA_STORE_VERSION,
  MetadataStore,
  MetadataStoreError,
  type PersistedDevice,
  type PersistedSession,
  type PersistedWorkspace,
} from './store/metadata-store.js';
export { readGitInfo, findGitRoot } from './workspace/git-info.js';
export {
  AcpJsonRpcError,
  AcpProcess,
  AcpProcessExitedError,
  type AcpExitInfo,
  type AcpIncomingRequest,
  type AcpNotification,
  type AcpProcessLogger,
  type AcpProcessOptions,
  type AcpProcessState,
} from './acp/process.js';
export {
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResult,
  NdjsonBuffer,
  parseJsonRpcLine,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type ParsedJsonRpcMessage,
} from './acp/json-rpc.js';
export {
  AcpCommandNotFoundError,
  resolveAcpCommand,
  selectLatestAgentVersionDir,
  toSpawnableAcpCommand,
  type AcpCommand,
} from './acp/resolve-command.js';

export interface DaemonFoundationInfo {
  readonly component: 'daemon';
  readonly protocolEventTypeCount: number;
}

export function getDaemonFoundationInfo(): DaemonFoundationInfo {
  return {
    component: 'daemon',
    protocolEventTypeCount: EVENT_TYPES.length,
  };
}
