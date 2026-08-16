import { AcpProcess, type AcpProcessLogger, type AcpProcessOptions } from './acp/process.js';
import { resolveAcpCommand } from './acp/resolve-command.js';

export interface DaemonAcpOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly onIncomingRequest?: AcpProcessOptions['onIncomingRequest'];
}

export interface DaemonStartOptions {
  readonly acp?: DaemonAcpOptions;
  readonly logger?: AcpProcessLogger;
}

export class Daemon {
  private constructor(private readonly acpProcess: AcpProcess) {}

  static async start(options: DaemonStartOptions = {}): Promise<Daemon> {
    const resolved = options.acp?.command
      ? { command: options.acp.command, args: options.acp.args ?? [] }
      : resolveAcpCommand();

    const acpProcess = await AcpProcess.spawn({
      command: resolved.command,
      args: resolved.args,
      ...(options.acp?.cwd !== undefined ? { cwd: options.acp.cwd } : {}),
      ...(options.acp?.env !== undefined ? { env: options.acp.env } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.acp?.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.acp.requestTimeoutMs }
        : {}),
      ...(options.acp?.shutdownTimeoutMs !== undefined
        ? { shutdownTimeoutMs: options.acp.shutdownTimeoutMs }
        : {}),
      ...(options.acp?.onIncomingRequest !== undefined
        ? { onIncomingRequest: options.acp.onIncomingRequest }
        : {}),
    });

    return new Daemon(acpProcess);
  }

  get acp(): AcpProcess {
    return this.acpProcess;
  }

  async stop(): Promise<void> {
    await this.acpProcess.shutdown();
  }
}
