import { delimiter } from 'node:path';

export const USAGE = `Usage:
  remote-dev [options] workspace list
  remote-dev [options] workspace select <path>
  remote-dev [options] workspace register <path>
  remote-dev [options] session create <workspaceId>
  remote-dev [options] session list [workspaceId]
  remote-dev [options] session send <sessionId> <text>
  remote-dev [options] session load <sessionId>
  remote-dev [options] e2e

Options:
  --state-dir <path>       Daemon metadata directory (or REMOTE_DEV_STATE_DIR)
  --allowed-root <path>    Repeatable workspace boundary (or REMOTE_DEV_ALLOWED_ROOTS)
  --acp-command <path>     ACP executable; omit to resolve Cursor CLI
  --acp-arg <arg>          Repeatable ACP argument
  --title <title>          Title for session create
  --prompt <text>          Initial prompt for session create
  --workspace <path>       Workspace path for e2e
  --json                   Print command results as JSON
  -h, --help               Show this help

e2e creates temporary state/workspace directories when those options are omitted.
One-shot commands require --state-dir and --allowed-root. The repository root is
never used as a default allowed root. session send loads the Cursor session first
because each invocation starts a new ACP process. Cancel a running prompt with
Ctrl+C on session send, or use the in-process e2e command. One-shot session
cancel is not supported: it would start a new ACP process and cannot interrupt
another process.
`;

export class RemoteDevUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteDevUsageError';
  }
}

export type RemoteDevCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'e2e'; readonly workspacePath: string | undefined }
  | { readonly kind: 'workspace.list' }
  | { readonly kind: 'workspace.register'; readonly path: string }
  | { readonly kind: 'session.list'; readonly workspaceId: string | undefined }
  | {
      readonly kind: 'session.create';
      readonly workspaceId: string;
      readonly title: string | null;
      readonly initialPrompt: string;
    }
  | { readonly kind: 'session.send'; readonly remoteSessionId: string; readonly text: string }
  | { readonly kind: 'session.load'; readonly remoteSessionId: string };

export interface ParsedRemoteDevArgv {
  readonly stateDir: string | undefined;
  readonly allowedRoots: readonly string[];
  readonly acpCommand: string | undefined;
  readonly acpArgs: readonly string[];
  readonly json: boolean;
  readonly command: RemoteDevCommand;
}

export function parseRemoteDevArgv(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedRemoteDevArgv {
  const positional: string[] = [];
  let stateDir = readEnvValue(env.REMOTE_DEV_STATE_DIR);
  const allowedRoots: string[] = [...splitEnvPaths(env.REMOTE_DEV_ALLOWED_ROOTS)];
  let acpCommand: string | undefined;
  const acpArgs: string[] = [];
  let json = false;
  let title: string | undefined;
  let prompt: string | undefined;
  let workspacePath: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--state-dir') {
      stateDir = requireOptionValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token === '--allowed-root') {
      allowedRoots.push(requireOptionValue(argv, index, token));
      index += 1;
      continue;
    }
    if (token === '--acp-command') {
      acpCommand = requireOptionValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token === '--acp-arg') {
      acpArgs.push(requireOptionValue(argv, index, token));
      index += 1;
      continue;
    }
    if (token === '--title') {
      title = requireOptionValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token === '--prompt') {
      prompt = requireOptionValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token === '--workspace') {
      workspacePath = requireOptionValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      throw new RemoteDevUsageError(`Unknown option: ${token}`);
    }
    positional.push(token);
  }

  if (help || positional[0] === 'help') {
    return {
      stateDir,
      allowedRoots,
      acpCommand,
      acpArgs,
      json,
      command: { kind: 'help' },
    };
  }

  if (acpCommand === undefined && acpArgs.length > 0) {
    throw new RemoteDevUsageError('--acp-arg requires --acp-command');
  }

  const command = parseCommand(positional, {
    title: title ?? null,
    initialPrompt: prompt ?? '',
    workspacePath,
  });
  assertCommandOptions(command, { title, prompt, workspacePath });

  return {
    stateDir,
    allowedRoots,
    acpCommand,
    acpArgs,
    json,
    command,
  };
}

function parseCommand(
  positional: readonly string[],
  extras: {
    readonly title: string | null;
    readonly initialPrompt: string;
    readonly workspacePath: string | undefined;
  },
): RemoteDevCommand {
  const [group, action, ...rest] = positional;
  if (group === undefined) {
    throw new RemoteDevUsageError('Missing command');
  }
  if (group === 'e2e') {
    if (action !== undefined) {
      throw new RemoteDevUsageError('e2e does not take positional arguments');
    }
    return { kind: 'e2e', workspacePath: extras.workspacePath };
  }
  if (group === 'workspace') {
    if (action === 'list') {
      requireNoExtra(rest, 'workspace list');
      return { kind: 'workspace.list' };
    }
    if (action === 'select' || action === 'register') {
      const path = rest[0];
      if (path === undefined || path.length === 0) {
        throw new RemoteDevUsageError(`${group} ${action} requires a path`);
      }
      requireNoExtra(rest.slice(1), `workspace ${action}`);
      return { kind: 'workspace.register', path };
    }
    throw new RemoteDevUsageError(`Unknown workspace command: ${action ?? '(missing)'}`);
  }
  if (group === 'session') {
    if (action === 'list') {
      const workspaceId = rest[0];
      requireNoExtra(rest.slice(workspaceId === undefined ? 0 : 1), 'session list');
      return { kind: 'session.list', workspaceId };
    }
    if (action === 'create') {
      const workspaceId = rest[0];
      if (workspaceId === undefined || workspaceId.length === 0) {
        throw new RemoteDevUsageError('session create requires a workspaceId');
      }
      requireNoExtra(rest.slice(1), 'session create');
      return {
        kind: 'session.create',
        workspaceId,
        title: extras.title,
        initialPrompt: extras.initialPrompt,
      };
    }
    if (action === 'send') {
      const remoteSessionId = rest[0];
      const text = rest.slice(1).join(' ');
      if (remoteSessionId === undefined || remoteSessionId.length === 0) {
        throw new RemoteDevUsageError('session send requires a sessionId');
      }
      if (text.length === 0) {
        throw new RemoteDevUsageError('session send requires text');
      }
      return { kind: 'session.send', remoteSessionId, text };
    }
    if (action === 'cancel') {
      throw new RemoteDevUsageError(
        'one-shot session cancel is not supported; use Ctrl+C on session send, or the e2e command',
      );
    }
    if (action === 'load') {
      const remoteSessionId = rest[0];
      if (remoteSessionId === undefined || remoteSessionId.length === 0) {
        throw new RemoteDevUsageError('session load requires a sessionId');
      }
      requireNoExtra(rest.slice(1), 'session load');
      return { kind: 'session.load', remoteSessionId };
    }
    throw new RemoteDevUsageError(`Unknown session command: ${action ?? '(missing)'}`);
  }
  throw new RemoteDevUsageError(`Unknown command: ${group}`);
}

function assertCommandOptions(
  command: RemoteDevCommand,
  extras: {
    readonly title: string | undefined;
    readonly prompt: string | undefined;
    readonly workspacePath: string | undefined;
  },
): void {
  if (
    command.kind !== 'session.create' &&
    (extras.title !== undefined || extras.prompt !== undefined)
  ) {
    throw new RemoteDevUsageError('--title and --prompt are only valid with session create');
  }
  if (command.kind !== 'e2e' && extras.workspacePath !== undefined) {
    throw new RemoteDevUsageError('--workspace is only valid with e2e');
  }
}

function requireOptionValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith('-')) {
    throw new RemoteDevUsageError(`${option} requires a value`);
  }
  return value;
}

function requireNoExtra(rest: readonly string[], command: string): void {
  if (rest.length > 0) {
    throw new RemoteDevUsageError(`Unexpected arguments for ${command}: ${rest.join(' ')}`);
  }
}

function readEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function splitEnvPaths(value: string | undefined): string[] {
  const raw = readEnvValue(value);
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
