#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRemoteDevArgv, RemoteDevUsageError, USAGE } from './argv.js';
import { runParsedRemoteDev, type RemoteDevIo } from './harness.js';

export { parseRemoteDevArgv, RemoteDevUsageError, USAGE } from './argv.js';
export {
  runLocalE2e,
  runParsedRemoteDev,
  type LocalE2eResult,
  type RemoteDevIo,
} from './harness.js';

export async function runRemoteDev(
  argv: readonly string[],
  io: RemoteDevIo = process,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const parsed = parseRemoteDevArgv(argv, env);
    await runParsedRemoteDev(parsed, io);
    return 0;
  } catch (error) {
    if (error instanceof RemoteDevUsageError) {
      io.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return 1;
  }
}

function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) {
    return false;
  }
  try {
    const self = resolve(fileURLToPath(import.meta.url));
    const invoked = resolve(entry);
    if (process.platform === 'win32') {
      return self.toLowerCase() === invoked.toLowerCase();
    }
    return self === invoked;
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  void runRemoteDev(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
