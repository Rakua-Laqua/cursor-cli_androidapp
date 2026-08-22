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
export { DiffPipeline } from './diff/diff-pipeline.js';
export {
  FileReadError,
  FileReader,
  MAX_FILE_READ_BYTES,
  MAX_FILE_READ_PATH_CHARS,
  readWorkspaceFile,
} from './file/file-reader.js';
export {
  DIFF_GIT_TIMEOUT_MS,
  GitDiffError,
  GitDiffSource,
  MAX_DIFF_FILE_BYTES,
  MAX_DIFF_FILES,
  MAX_DIFF_PAYLOAD_BYTES,
  emptySnapshot,
  type DiffCollectInput,
  type DiffSource,
} from './diff/git-diff-source.js';
export { isSensitivePath } from './diff/sensitive-path.js';
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
