import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import type { DiffChangeKind, DiffFilePayload, DiffSnapshotPayload } from '@cursor-remote/protocol';

import { findGitRoot } from '../workspace/git-info.js';
import { isPathInsideRoot } from '../workspace/path-guard.js';
import { isSensitivePath } from './sensitive-path.js';

export const DIFF_GIT_TIMEOUT_MS = 5000;
export const MAX_DIFF_FILES = 50;
export const MAX_DIFF_FILE_BYTES = 32768;
export const MAX_DIFF_PAYLOAD_BYTES = 262144;

const DIFF_GIT_MAX_BUFFER = 1024 * 1024;
const GIT_ENV_REMOVE = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_EXTERNAL_DIFF',
  'GIT_TEXTCONV',
  'GIT_PAGER',
]);

export class GitDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitDiffError';
  }
}

export interface DiffCollectInput {
  readonly workspaceId: string;
  readonly workspacePath: string;
}

export interface DiffSource {
  collect(input: DiffCollectInput): DiffSnapshotPayload;
}

interface RawStatusEntry {
  readonly x: string;
  readonly y: string;
  readonly path: string;
  readonly previousPath: string | null;
}

interface StatusEntry {
  readonly x: string;
  readonly y: string;
  readonly path: string;
  readonly previousPath: string | null;
  readonly gitPath: string;
  readonly gitPreviousPath: string | null;
  readonly change: DiffChangeKind;
}

interface GitContext {
  readonly workspacePath: string;
  readonly gitRoot: string;
  readonly headRef: string;
}

type PathInspect = 'regular' | 'nonregular' | 'missing' | 'unsafe';

export class GitDiffSource implements DiffSource {
  collect(input: DiffCollectInput): DiffSnapshotPayload {
    const gitRoot = resolveCanonicalGitRoot(input.workspacePath);
    if (gitRoot === undefined) {
      return emptySnapshot(input.workspaceId);
    }
    if (!isPathInsideRoot(input.workspacePath, gitRoot)) {
      throw new GitDiffError('Workspace is outside the Git repository.');
    }

    const prefix = deriveWorkspacePrefix(gitRoot, input.workspacePath);
    const statusPathspec = prefix.length === 0 ? '.' : prefix;
    const status = runGit(gitRoot, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      statusPathspec,
    ]);
    const ctx: GitContext = {
      workspacePath: input.workspacePath,
      gitRoot,
      headRef: resolveHeadRef(gitRoot),
    };
    let omittedCount = 0;
    const accepted: StatusEntry[] = [];

    for (const entry of parsePorcelainZ(status)) {
      if (entry.x === '!' && entry.y === '!') {
        continue;
      }
      const mapped = mapStatusEntry(entry, prefix);
      if (mapped === undefined) {
        omittedCount += 1;
        continue;
      }
      if (
        mapped.change !== 'deleted' &&
        inspectWorkspacePath(input.workspacePath, mapped.path) === 'unsafe'
      ) {
        omittedCount += 1;
        continue;
      }
      accepted.push(mapped);
    }

    const files: DiffFilePayload[] = [];
    let truncated = omittedCount > 0;
    for (let index = 0; index < accepted.length; index += 1) {
      const entry = accepted[index];
      if (entry === undefined) {
        continue;
      }
      if (files.length >= MAX_DIFF_FILES) {
        omittedCount += accepted.length - index;
        truncated = true;
        break;
      }
      const file = buildFile(entry, ctx);
      files.push(file);
      if (file.truncated) {
        truncated = true;
      }
    }

    return fitSnapshotPayload({
      workspaceId: input.workspaceId,
      available: true,
      source: 'git',
      files,
      truncated,
      omittedCount,
      totalAdditions: sumCounts(files, 'additions'),
      totalDeletions: sumCounts(files, 'deletions'),
    });
  }
}

export function emptySnapshot(workspaceId: string): DiffSnapshotPayload {
  return {
    workspaceId,
    available: false,
    source: 'none',
    files: [],
    truncated: false,
    omittedCount: 0,
    totalAdditions: 0,
    totalDeletions: 0,
  };
}

function buildFile(entry: StatusEntry, ctx: GitContext): DiffFilePayload {
  const sensitive =
    isSensitivePath(entry.path) ||
    (entry.previousPath !== null && isSensitivePath(entry.previousPath));
  const inspect =
    entry.change === 'deleted' ? 'missing' : inspectWorkspacePath(ctx.workspacePath, entry.path);
  const gitNonRegular = entry.change !== 'untracked' && isGitNonRegular(entry, ctx);
  const nonRegular = inspect === 'nonregular' || inspect === 'unsafe' || gitNonRegular;

  if (nonRegular) {
    return filePayload(entry, {
      binary: true,
      sensitive,
      additions: 0,
      deletions: 0,
      unifiedDiff: null,
      truncated: false,
    });
  }

  if (sensitive) {
    return filePayload(entry, {
      binary: false,
      sensitive: true,
      additions: 0,
      deletions: 0,
      unifiedDiff: null,
      truncated: false,
    });
  }

  if (entry.change === 'untracked') {
    return synthesizeUntracked(entry, ctx.workspacePath);
  }

  return trackedPatch(entry, ctx);
}

function trackedPatch(entry: StatusEntry, ctx: GitContext): DiffFilePayload {
  const gitPaths = entry.previousPath === null ? [entry.path] : [entry.previousPath, entry.path];
  const stats = parseNumstat(
    runGit(ctx.workspacePath, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--numstat',
      '-M',
      ctx.headRef,
      '--',
      ...gitPaths,
    ]),
  );
  if (stats.binary) {
    return filePayload(entry, {
      binary: true,
      sensitive: false,
      additions: 0,
      deletions: 0,
      unifiedDiff: null,
      truncated: false,
    });
  }

  const patch = decodeBuffer(
    runGit(ctx.workspacePath, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '-M',
      '-U3',
      ctx.headRef,
      '--',
      ...gitPaths,
    ]),
  );
  if (isBinaryPatch(patch)) {
    return filePayload(entry, {
      binary: true,
      sensitive: false,
      additions: 0,
      deletions: 0,
      unifiedDiff: null,
      truncated: false,
    });
  }

  const limited = truncateUtf8(patch, MAX_DIFF_FILE_BYTES);
  return filePayload(entry, {
    binary: false,
    sensitive: false,
    additions: stats.additions,
    deletions: stats.deletions,
    unifiedDiff: limited.text,
    truncated: limited.truncated,
  });
}

function synthesizeUntracked(entry: StatusEntry, workspacePath: string): DiffFilePayload {
  const abs = joinWorkspace(workspacePath, entry.path);
  const buf = readBoundedFile(abs);
  if (buf === undefined || buf.includes(0)) {
    return filePayload(entry, {
      binary: buf !== undefined && buf.includes(0),
      sensitive: false,
      additions: 0,
      deletions: 0,
      unifiedDiff: null,
      truncated: false,
    });
  }

  const content = buf.toString('utf8');
  const patch = synthesizeAddedDiff(entry.path, content);
  const limited = truncateUtf8(patch, MAX_DIFF_FILE_BYTES);
  return filePayload(entry, {
    binary: false,
    sensitive: false,
    additions: splitContentLines(content).lines.length,
    deletions: 0,
    unifiedDiff: limited.text,
    truncated: limited.truncated || fileWasCapped(abs, buf),
  });
}

function filePayload(
  entry: StatusEntry,
  fields: {
    readonly binary: boolean;
    readonly sensitive: boolean;
    readonly additions: number;
    readonly deletions: number;
    readonly unifiedDiff: string | null;
    readonly truncated: boolean;
  },
): DiffFilePayload {
  return {
    path: entry.path,
    previousPath: entry.change === 'renamed' ? entry.previousPath : null,
    change: entry.change,
    binary: fields.binary,
    sensitive: fields.sensitive,
    additions: fields.additions,
    deletions: fields.deletions,
    unifiedDiff: fields.unifiedDiff,
    truncated: fields.truncated,
  };
}

function changeKind(x: string, y: string): DiffChangeKind {
  if (x === '?' && y === '?') {
    return 'untracked';
  }
  if (x === 'C' || y === 'C') {
    return 'added';
  }
  if (x === 'R' || y === 'R') {
    return 'renamed';
  }
  if (x === 'D' || y === 'D') {
    return 'deleted';
  }
  if (x === 'A') {
    return 'added';
  }
  return 'modified';
}

function mapStatusEntry(entry: RawStatusEntry, prefix: string): StatusEntry | undefined {
  const gitPath = toPosixRelative(entry.path);
  const gitPreviousPath = entry.previousPath === null ? null : toPosixRelative(entry.previousPath);
  const path = toWorkspaceRelative(gitPath, prefix);
  if (path === undefined) {
    return undefined;
  }
  let previousPath: string | null = null;
  if (gitPreviousPath !== null) {
    const normalizedPrevious = toWorkspaceRelative(gitPreviousPath, prefix);
    if (normalizedPrevious === undefined) {
      return undefined;
    }
    previousPath = normalizedPrevious;
  }
  const change = changeKind(entry.x, entry.y);
  return {
    x: entry.x,
    y: entry.y,
    path,
    previousPath: change === 'renamed' ? previousPath : null,
    gitPath,
    gitPreviousPath,
    change,
  };
}

function parsePorcelainZ(buffer: Buffer): RawStatusEntry[] {
  const entries: RawStatusEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer[offset] === 0) {
      offset += 1;
      continue;
    }
    if (offset + 3 > buffer.length) {
      throw new GitDiffError('Git status output is truncated.');
    }
    const x = String.fromCharCode(buffer[offset] ?? 0);
    const y = String.fromCharCode(buffer[offset + 1] ?? 0);
    if (buffer[offset + 2] !== 0x20) {
      throw new GitDiffError('Git status output is malformed.');
    }
    offset += 3;
    const first = readCString(buffer, offset);
    if (first === undefined) {
      throw new GitDiffError('Git status output is truncated.');
    }
    offset = first.next;
    const twoPath = x === 'R' || x === 'C' || y === 'R' || y === 'C';
    if (twoPath) {
      const second = readCString(buffer, offset);
      if (second === undefined) {
        throw new GitDiffError('Git status output is truncated.');
      }
      offset = second.next;
      entries.push({ x, y, path: first.value, previousPath: second.value });
    } else {
      entries.push({ x, y, previousPath: null, path: first.value });
    }
  }
  return entries;
}

function readCString(
  buffer: Buffer,
  start: number,
): { readonly value: string; readonly next: number } | undefined {
  const end = buffer.indexOf(0, start);
  if (end === -1) {
    return undefined;
  }
  return { value: buffer.subarray(start, end).toString('utf8'), next: end + 1 };
}

function parseNumstat(buffer: Buffer): { additions: number; deletions: number; binary: boolean } {
  if (buffer.length === 0) {
    return { additions: 0, deletions: 0, binary: false };
  }
  const tab = buffer.indexOf(0x09);
  if (tab <= 0) {
    return { additions: 0, deletions: 0, binary: false };
  }
  const secondTab = buffer.indexOf(0x09, tab + 1);
  const nul = buffer.indexOf(0, tab + 1);
  const newline = indexOfNewline(buffer, tab + 1);
  const candidates = [secondTab, nul, newline].filter((value) => value >= 0);
  const end = candidates.length === 0 ? buffer.length : Math.min(...candidates);
  const addedToken = buffer.subarray(0, tab).toString('utf8');
  const deletedToken = buffer
    .subarray(tab + 1, end)
    .toString('utf8')
    .replace(/\r$/, '');
  if (addedToken === '-' || deletedToken === '-') {
    return { additions: 0, deletions: 0, binary: true };
  }
  const additions = Number.parseInt(addedToken, 10);
  const deletions = Number.parseInt(deletedToken, 10);
  if (
    !Number.isInteger(additions) ||
    !Number.isInteger(deletions) ||
    additions < 0 ||
    deletions < 0
  ) {
    return { additions: 0, deletions: 0, binary: false };
  }
  return { additions, deletions, binary: false };
}

function indexOfNewline(buffer: Buffer, start: number): number {
  const lf = buffer.indexOf(0x0a, start);
  const cr = buffer.indexOf(0x0d, start);
  if (lf < 0) {
    return cr;
  }
  if (cr < 0) {
    return lf;
  }
  return Math.min(lf, cr);
}

function isBinaryPatch(patch: string): boolean {
  return /^(GIT binary patch|Binary files .* differ)$/m.test(patch);
}

function isGitNonRegular(entry: StatusEntry, ctx: GitContext): boolean {
  const paths =
    entry.gitPreviousPath === null ? [entry.gitPath] : [entry.gitPreviousPath, entry.gitPath];
  for (const gitPath of paths) {
    const staged = decodeBuffer(runGit(ctx.gitRoot, ['ls-files', '-s', '--', gitPath]));
    if (hasNonRegularMode(staged)) {
      return true;
    }
    const tree = decodeBuffer(runGit(ctx.gitRoot, ['ls-tree', ctx.headRef, '--', gitPath]));
    if (hasNonRegularMode(tree)) {
      return true;
    }
  }
  return false;
}

function hasNonRegularMode(output: string): boolean {
  const mode = output.trim().split(/[\s\t]/, 1)[0];
  return mode === '120000' || mode === '160000';
}

function resolveHeadRef(gitRoot: string): string {
  const head = spawnGit(gitRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (isTimeout(head.error) || head.error !== undefined || head.signal !== null) {
    throw gitFailure(head, 'Git HEAD lookup failed.');
  }
  if (head.status === 0) {
    return 'HEAD';
  }
  const empty = runGit(gitRoot, ['hash-object', '-t', 'tree', '--stdin'], Buffer.alloc(0));
  const oid = decodeBuffer(empty).trim();
  if (!/^[0-9a-f]{40}$/i.test(oid)) {
    throw new GitDiffError('Unable to resolve the empty tree for an unborn repository.');
  }
  return oid;
}

function resolveCanonicalGitRoot(workspacePath: string): string | undefined {
  const found = findGitRoot(workspacePath);
  if (found === undefined) {
    return undefined;
  }
  try {
    return realpathSync(found);
  } catch {
    return found;
  }
}

function deriveWorkspacePrefix(gitRoot: string, workspacePath: string): string {
  const rel = toPosixRelative(relative(gitRoot, workspacePath));
  if (rel === '') {
    return '';
  }
  if (!isLexicalWorkspacePath(rel)) {
    throw new GitDiffError('Workspace is outside the Git repository.');
  }
  return rel;
}

function toWorkspaceRelative(gitRelPosix: string, prefix: string): string | undefined {
  const posix = toPosixRelative(gitRelPosix);
  if (posix.length === 0 || posix === '.') {
    return undefined;
  }
  let rest: string;
  if (prefix.length === 0) {
    rest = posix;
  } else if (posix === prefix) {
    return undefined;
  } else if (posix.startsWith(`${prefix}/`)) {
    rest = posix.slice(prefix.length + 1);
  } else {
    return undefined;
  }
  if (!isLexicalWorkspacePath(rest)) {
    return undefined;
  }
  return rest;
}

function inspectWorkspacePath(workspacePath: string, relativePosix: string): PathInspect {
  if (!isLexicalWorkspacePath(relativePosix)) {
    return 'unsafe';
  }
  const parts = relativePosix.split('/');
  let current = workspacePath;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) {
      return 'unsafe';
    }
    current = join(current, part);
    if (!existsSync(current)) {
      return index === parts.length - 1 ? 'missing' : 'unsafe';
    }
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return 'unsafe';
    }
    if (stat.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(current);
      } catch {
        return 'unsafe';
      }
      if (!isPathInsideRoot(real, workspacePath)) {
        return 'unsafe';
      }
      if (index === parts.length - 1) {
        return 'nonregular';
      }
      current = real;
      continue;
    }
    if (index === parts.length - 1) {
      return stat.isFile() ? 'regular' : 'nonregular';
    }
    if (!stat.isDirectory()) {
      return 'unsafe';
    }
  }
  return 'missing';
}

function isLexicalWorkspacePath(relativePosix: string): boolean {
  if (relativePosix.length === 0 || relativePosix.includes('\0')) {
    return false;
  }
  if (
    relativePosix.startsWith('/') ||
    relativePosix.startsWith('\\') ||
    /^[a-zA-Z]:/.test(relativePosix)
  ) {
    return false;
  }
  const parts = relativePosix.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function joinWorkspace(workspacePath: string, relativePosix: string): string {
  return join(workspacePath, ...relativePosix.split('/'));
}

function toPosixRelative(value: string): string {
  return value.replaceAll('\\', '/');
}

function readBoundedFile(absPath: string): Buffer | undefined {
  let fd: number | undefined;
  try {
    const size = statSync(absPath).size;
    const toRead = Math.min(size, MAX_DIFF_FILE_BYTES + 1);
    fd = openSync(absPath, 'r');
    const buf = Buffer.alloc(toRead);
    const bytesRead = readSync(fd, buf, 0, toRead, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function fileWasCapped(absPath: string, buf: Buffer): boolean {
  try {
    return statSync(absPath).size > buf.length;
  } catch {
    return false;
  }
}

function synthesizeAddedDiff(posixPath: string, content: string): string {
  const { lines, missingNewline } = splitContentLines(content);
  const header = [
    `diff --git a/${posixPath} b/${posixPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${posixPath}`,
  ];
  if (lines.length === 0) {
    return `${header.join('\n')}\n`;
  }
  const hunk = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)];
  if (missingNewline) {
    hunk.push('\\ No newline at end of file');
  }
  return `${header.join('\n')}\n${hunk.join('\n')}\n`;
}

function splitContentLines(content: string): { lines: string[]; missingNewline: boolean } {
  if (content.length === 0) {
    return { lines: [], missingNewline: false };
  }
  const missingNewline = !content.endsWith('\n');
  const sliced = missingNewline ? content : content.slice(0, -1);
  return { lines: sliced.split('\n'), missingNewline };
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) {
    return { text, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

function fitSnapshotPayload(snapshot: DiffSnapshotPayload): DiffSnapshotPayload {
  let files = snapshot.files.slice();
  let omittedCount = snapshot.omittedCount;
  let truncated = snapshot.truncated;

  const serializedSize = (current: DiffFilePayload[]): number =>
    Buffer.byteLength(
      JSON.stringify({
        ...snapshot,
        files: current,
        omittedCount,
        truncated,
        totalAdditions: sumCounts(current, 'additions'),
        totalDeletions: sumCounts(current, 'deletions'),
      }),
      'utf8',
    );

  while (files.length > 0 && serializedSize(files) > MAX_DIFF_PAYLOAD_BYTES) {
    const last = files[files.length - 1];
    if (last === undefined) {
      break;
    }
    const currentBytes =
      last.unifiedDiff === null ? 0 : Buffer.byteLength(last.unifiedDiff, 'utf8');
    const overflow = serializedSize(files) - MAX_DIFF_PAYLOAD_BYTES;
    if (last.unifiedDiff !== null && currentBytes > 0) {
      const keep = Math.max(0, currentBytes - overflow);
      if (keep > 0) {
        const limited = truncateUtf8(last.unifiedDiff, keep);
        files = [
          ...files.slice(0, -1),
          {
            ...last,
            unifiedDiff: limited.text.length > 0 ? limited.text : null,
            truncated: true,
          },
        ];
        truncated = true;
        continue;
      }
      files = [
        ...files.slice(0, -1),
        {
          ...last,
          unifiedDiff: null,
          truncated: true,
        },
      ];
      truncated = true;
      continue;
    }
    files = files.slice(0, -1);
    omittedCount += 1;
    truncated = true;
  }

  return {
    ...snapshot,
    files,
    omittedCount,
    truncated,
    totalAdditions: sumCounts(files, 'additions'),
    totalDeletions: sumCounts(files, 'deletions'),
  };
}

function sumCounts(files: readonly DiffFilePayload[], key: 'additions' | 'deletions'): number {
  return files.reduce((sum, file) => sum + file[key], 0);
}

function runGit(cwd: string, args: readonly string[], input?: Buffer): Buffer {
  const result = spawnGit(cwd, args, input);
  if (isTimeout(result.error)) {
    throw gitFailure(result, 'Git command failed.');
  }
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    result.stdout === null
  ) {
    throw gitFailure(result, 'Git command failed.');
  }
  return result.stdout;
}

function spawnGit(cwd: string, args: readonly string[], input?: Buffer): SpawnSyncReturns<Buffer> {
  const argv = [
    '--no-pager',
    '-c',
    'color.ui=false',
    '-c',
    'diff.external=',
    '-c',
    'core.pager=cat',
    '-c',
    'core.quotepath=false',
    ...args,
  ];
  return spawnSync('git', argv, {
    cwd,
    env: sanitizedGitEnv(),
    encoding: 'buffer',
    timeout: DIFF_GIT_TIMEOUT_MS,
    maxBuffer: DIFF_GIT_MAX_BUFFER,
    shell: false,
    windowsHide: true,
    ...(input !== undefined ? { input } : {}),
  });
}

function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (GIT_ENV_REMOVE.has(key.toUpperCase())) {
      delete env[key];
    }
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  return env;
}

function gitFailure(result: SpawnSyncReturns<Buffer>, fallback: string): GitDiffError {
  if (isTimeout(result.error)) {
    return new GitDiffError('Git timed out');
  }
  if (result.error) {
    return new GitDiffError(result.error.message || fallback);
  }
  const stderr = decodeBuffer(result.stderr).split(/\r?\n/, 1)[0]?.trim();
  return new GitDiffError(stderr && stderr.length > 0 ? stderr : fallback);
}

function isTimeout(error: Error | undefined): boolean {
  if (error === undefined) {
    return false;
  }
  return ('code' in error && error.code === 'ETIMEDOUT') || error.message.includes('ETIMEDOUT');
}

function decodeBuffer(buffer: Buffer | null | undefined): string {
  if (buffer === undefined || buffer === null || buffer.length === 0) {
    return '';
  }
  return buffer.toString('utf8');
}
