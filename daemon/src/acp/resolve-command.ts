import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface AcpCommand {
  readonly command: string;
  readonly args: readonly string[];
}

const VERSION_DIR_PATTERN = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/i;

export class AcpCommandNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpCommandNotFoundError';
  }
}

export function resolveAcpCommand(env: NodeJS.ProcessEnv = process.env): AcpCommand {
  const fromInstall = resolveFromCursorAgentInstall(env);
  if (fromInstall) {
    return fromInstall;
  }

  const fromPath = resolveFromPath(env);
  if (fromPath) {
    return fromPath;
  }

  throw new AcpCommandNotFoundError(
    'Cursor CLI ACP command was not found. Install Cursor CLI or pass an explicit command.',
  );
}

export function selectLatestAgentVersionDir(names: readonly string[]): string | undefined {
  const ranked = names
    .map((name) => {
      const key = versionSortKey(name);
      return key === undefined ? undefined : { name, key };
    })
    .filter((entry): entry is { name: string; key: number } => entry !== undefined)
    .sort((a, b) => b.key - a.key || b.name.localeCompare(a.name));

  return ranked[0]?.name;
}

function resolveFromCursorAgentInstall(env: NodeJS.ProcessEnv): AcpCommand | undefined {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) {
    return undefined;
  }

  const versionsRoot = join(localAppData, 'cursor-agent', 'versions');
  if (!existsSync(versionsRoot)) {
    return undefined;
  }

  const latest = selectLatestAgentVersionDir(readdirSync(versionsRoot));
  if (!latest) {
    return undefined;
  }

  const versionDir = join(versionsRoot, latest);
  const nodePath = join(versionDir, 'node.exe');
  const indexPath = join(versionDir, 'index.js');
  if (existsSync(nodePath) && existsSync(indexPath)) {
    return { command: nodePath, args: [indexPath, 'acp'] };
  }

  const unixNode = join(versionDir, 'node');
  if (existsSync(unixNode) && existsSync(indexPath)) {
    return { command: unixNode, args: [indexPath, 'acp'] };
  }

  return undefined;
}

function resolveFromPath(env: NodeJS.ProcessEnv): AcpCommand | undefined {
  const pathValue = env.PATH ?? env.Path;
  if (!pathValue) {
    return undefined;
  }

  const names =
    process.platform === 'win32' ? ['agent.cmd', 'agent.exe', 'agent'] : ['agent', 'agent.exe'];

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        return { command: candidate, args: ['acp'] };
      }
    }
  }

  return undefined;
}

function versionSortKey(dirName: string): number | undefined {
  const match = VERSION_DIR_PATTERN.exec(dirName);
  if (!match) {
    return undefined;
  }
  const year = match[1];
  const month = match[2];
  const day = match[3];
  if (year === undefined || month === undefined || day === undefined) {
    return undefined;
  }
  return Number(`${year}${month.padStart(2, '0')}${day.padStart(2, '0')}`);
}
