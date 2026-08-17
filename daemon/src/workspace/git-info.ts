import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface GitInfo {
  readonly gitBranch: string | null;
  readonly modified: boolean;
}

export function readGitInfo(workspacePath: string): GitInfo {
  if (!findGitRoot(workspacePath)) {
    return { gitBranch: null, modified: false };
  }

  const branch = gitOutput(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = gitOutput(workspacePath, ['status', '--porcelain']);

  return {
    gitBranch: resolveBranchName(workspacePath, branch),
    modified: status !== undefined && status.length > 0,
  };
}

function resolveBranchName(workspacePath: string, branch: string | undefined): string | null {
  if (branch === undefined) {
    return null;
  }
  if (branch === 'HEAD') {
    return gitOutput(workspacePath, ['rev-parse', '--short', 'HEAD']) ?? 'HEAD';
  }
  return branch;
}

function gitOutput(cwd: string, args: readonly string[]): string | undefined {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  if (result.status !== 0 || result.stdout === null) {
    return undefined;
  }
  const text = result.stdout.trim();
  return text.length > 0 ? text : undefined;
}

export function findGitRoot(start: string): string | undefined {
  let current = start;
  while (true) {
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}
