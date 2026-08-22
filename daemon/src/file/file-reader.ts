import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import type { FileContentPayload, JsonObject, RemoteCommand } from '@cursor-remote/protocol';

import { isSensitivePath } from '../diff/sensitive-path.js';
import { isPathInsideRoot } from '../workspace/path-guard.js';
import { WorkspaceNotFoundError, type WorkspaceManager } from '../workspace/workspace-manager.js';

export const MAX_FILE_READ_PATH_CHARS = 1024;
export const MAX_FILE_READ_BYTES = 262144;

export class FileReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileReadError';
  }
}

export class FileReader {
  constructor(
    private readonly sessions: { workspaceIdForSession(sessionId: string): string },
    private readonly workspaces: WorkspaceManager,
  ) {}

  handleCommand(command: RemoteCommand): FileContentPayload {
    if (command.type !== 'file.read') {
      throw new FileReadError(`Unsupported command type: ${command.type}`);
    }
    const sessionId = command.sessionId;
    if (sessionId === null || sessionId.length === 0) {
      throw new FileReadError('sessionId is required');
    }
    const requestedPath = readCommandPath(command.payload);
    return this.read(sessionId, requestedPath);
  }

  read(sessionId: string, requestedPath: string): FileContentPayload {
    const workspaceId = this.sessions.workspaceIdForSession(sessionId);
    return readWorkspaceFile(this.workspaces, workspaceId, requestedPath);
  }
}

export function readWorkspaceFile(
  workspaces: WorkspaceManager,
  workspaceId: string,
  requestedPath: string,
): FileContentPayload {
  const relativePath = assertSafeRelativePath(requestedPath);
  if (isSensitivePath(relativePath)) {
    throw new FileReadError('File is not readable');
  }

  let root: string;
  try {
    root = workspaces.resolveTrustedPath(workspaceId);
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) {
      throw error;
    }
    throw new FileReadError('Workspace is not readable');
  }

  const candidate = join(root, ...relativePath.split('/'));
  if (!existsSync(candidate)) {
    throw new FileReadError('File not found');
  }

  let canonical: string;
  try {
    canonical = realpathSync(candidate);
  } catch {
    throw new FileReadError('File not found');
  }

  if (!isPathInsideRoot(canonical, root)) {
    throw new FileReadError('Path is outside the workspace');
  }

  const canonicalRelative = toPosixRelative(relative(root, canonical));
  if (
    canonicalRelative.length === 0 ||
    canonicalRelative === '.' ||
    canonicalRelative === '..' ||
    canonicalRelative.startsWith('../')
  ) {
    throw new FileReadError('Path is outside the workspace');
  }
  if (isSensitivePath(canonicalRelative)) {
    throw new FileReadError('File is not readable');
  }

  let fileStat;
  try {
    fileStat = statSync(canonical);
  } catch {
    throw new FileReadError('File not found');
  }
  if (!fileStat.isFile()) {
    throw new FileReadError('File is not readable');
  }

  const { buffer, truncated } = readLimited(canonical);
  const decoded = decodeUtf8Content(buffer, truncated);
  return {
    path: canonicalRelative,
    content: decoded.content,
    truncated: decoded.truncated,
  };
}

function readCommandPath(payload: JsonObject): string {
  const value = payload.path;
  if (typeof value !== 'string') {
    throw new FileReadError('path must be a string');
  }
  return value;
}

function assertSafeRelativePath(input: string): string {
  if (input.length === 0 || input.length > MAX_FILE_READ_PATH_CHARS) {
    throw new FileReadError(
      input.length > MAX_FILE_READ_PATH_CHARS ? 'path is too long' : 'path is invalid',
    );
  }
  if (input.includes('\0') || input.includes(':') || input.includes('\\')) {
    throw new FileReadError('path is invalid');
  }
  if (isAbsolute(input) || input.startsWith('/') || input.startsWith('//')) {
    throw new FileReadError('path is invalid');
  }
  const parts = input.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new FileReadError('path is invalid');
  }
  return parts.join('/');
}

function toPosixRelative(value: string): string {
  return value.replaceAll('\\', '/');
}

function readLimited(canonical: string): { buffer: Buffer; truncated: boolean } {
  let fd: number | undefined;
  try {
    fd = openSync(canonical, 'r');
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new FileReadError('File is not readable');
    }
    const scratch = Buffer.alloc(MAX_FILE_READ_BYTES + 1);
    let offset = 0;
    while (offset < scratch.length) {
      const n = readSync(fd, scratch, offset, scratch.length - offset, offset);
      if (n === 0) {
        break;
      }
      offset += n;
    }
    const truncated = offset > MAX_FILE_READ_BYTES;
    return {
      buffer: scratch.subarray(0, truncated ? MAX_FILE_READ_BYTES : offset),
      truncated,
    };
  } catch (error) {
    if (error instanceof FileReadError) {
      throw error;
    }
    throw new FileReadError('File is not readable');
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors so raw filesystem messages cannot leak.
      }
    }
  }
}

function decodeUtf8Content(
  buffer: Buffer,
  truncated: boolean,
): { content: string; truncated: boolean } {
  if (buffer.includes(0)) {
    throw new FileReadError('File is not readable');
  }
  const bounded = truncated ? cutToUtf8Boundary(buffer) : buffer;
  if (!isWellFormedUtf8(bounded)) {
    throw new FileReadError('File is not readable');
  }
  return {
    content: bounded.toString('utf8'),
    truncated,
  };
}

function cutToUtf8Boundary(buffer: Buffer): Buffer {
  if (buffer.length === 0) {
    return buffer;
  }
  const strip = incompleteValidPrefixBytes(buffer);
  if (strip < 0) {
    throw new FileReadError('File is not readable');
  }
  if (strip === 0) {
    return buffer;
  }
  return buffer.subarray(0, buffer.length - strip);
}

function incompleteValidPrefixBytes(buffer: Buffer): number {
  const end = buffer.length;
  let index = end - 1;
  let continuations = 0;
  while (index >= 0 && isContinuation(buffer[index]!)) {
    continuations += 1;
    if (continuations > 3) {
      return -1;
    }
    index -= 1;
  }
  if (index < 0) {
    return -1;
  }
  const lead = buffer[index]!;
  const have = end - index;
  const need = utf8SequenceLength(lead);
  if (need === undefined) {
    return -1;
  }
  if (have === need) {
    return 0;
  }
  if (have > need || have > 3) {
    return -1;
  }
  if (!isValidUtf8Prefix(buffer, index, have, need)) {
    return -1;
  }
  return have;
}

function utf8SequenceLength(lead: number): number | undefined {
  if (lead <= 0x7f) {
    return 1;
  }
  if (lead >= 0xc2 && lead <= 0xdf) {
    return 2;
  }
  if (lead >= 0xe0 && lead <= 0xef) {
    return 3;
  }
  if (lead >= 0xf0 && lead <= 0xf4) {
    return 4;
  }
  return undefined;
}

function isValidUtf8Prefix(buffer: Buffer, start: number, have: number, need: number): boolean {
  if (have < 1 || have > 3 || have >= need) {
    return false;
  }
  if (need === 2) {
    return have === 1;
  }
  const second = have >= 2 ? buffer[start + 1]! : undefined;
  if (second !== undefined && !isContinuation(second)) {
    return false;
  }
  const lead = buffer[start]!;
  if (need === 3) {
    if (lead === 0xe0 && second !== undefined && second < 0xa0) {
      return false;
    }
    if (lead === 0xed && second !== undefined && second >= 0xa0) {
      return false;
    }
    return true;
  }
  if (need === 4) {
    if (have === 3 && !isContinuation(buffer[start + 2]!)) {
      return false;
    }
    if (lead === 0xf0 && second !== undefined && second < 0x90) {
      return false;
    }
    if (lead === 0xf4 && second !== undefined && second >= 0x90) {
      return false;
    }
    return true;
  }
  return false;
}

function isWellFormedUtf8(buffer: Buffer): boolean {
  let index = 0;
  while (index < buffer.length) {
    const lead = buffer[index]!;
    const need = utf8SequenceLength(lead);
    if (need === undefined || index + need > buffer.length) {
      return false;
    }
    for (let offset = 1; offset < need; offset += 1) {
      if (!isContinuation(buffer[index + offset]!)) {
        return false;
      }
    }
    if (need === 3) {
      const second = buffer[index + 1]!;
      if ((lead === 0xe0 && second < 0xa0) || (lead === 0xed && second >= 0xa0)) {
        return false;
      }
    }
    if (need === 4) {
      const second = buffer[index + 1]!;
      if ((lead === 0xf0 && second < 0x90) || (lead === 0xf4 && second >= 0x90)) {
        return false;
      }
    }
    index += need;
  }
  return true;
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}
