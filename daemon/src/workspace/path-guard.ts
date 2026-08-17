import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class WorkspaceNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceNotAllowedError';
  }
}

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

export function canonicalizeRoot(root: string): string {
  const resolved = resolve(root);
  if (existsSync(resolved)) {
    return realpathSync(resolved);
  }
  return resolved;
}

export function canonicalizeExistingPath(input: string): string {
  const resolved = resolve(input);
  if (!existsSync(resolved)) {
    throw new WorkspacePathError(`Path does not exist: ${resolved}`);
  }
  return realpathSync(resolved);
}

export function isPathInsideRoot(candidate: string, root: string): boolean {
  const rel = relative(normalizeForCompare(root), normalizeForCompare(candidate));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function findAllowedRoot(
  candidate: string,
  allowedRoots: readonly string[],
): string | undefined {
  const canonical = existsSync(candidate) ? realpathSync(candidate) : resolve(candidate);
  for (const root of allowedRoots) {
    if (isPathInsideRoot(canonical, canonicalizeRoot(root))) {
      return canonicalizeRoot(root);
    }
  }
  return undefined;
}

export function assertDirectoryAllowed(input: string, allowedRoots: readonly string[]): string {
  const resolved = resolve(input);
  if (!existsSync(resolved)) {
    throw new WorkspacePathError(`Path does not exist: ${resolved}`);
  }

  const stat = lstatSync(resolved);
  if (!stat.isDirectory() && !stat.isSymbolicLink()) {
    throw new WorkspacePathError(`Workspace path is not a directory: ${resolved}`);
  }

  const canonical = (() => {
    try {
      return realpathSync(resolved);
    } catch (error) {
      throw new WorkspacePathError(
        error instanceof Error ? error.message : `Cannot resolve path: ${resolved}`,
      );
    }
  })();
  if (!statSync(canonical).isDirectory()) {
    throw new WorkspacePathError(`Workspace path is not a directory: ${canonical}`);
  }

  if (findAllowedRoot(canonical, allowedRoots) === undefined) {
    throw new WorkspaceNotAllowedError(`Path is outside allowedRoots: ${canonical}`);
  }

  return canonical;
}

function normalizeForCompare(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
