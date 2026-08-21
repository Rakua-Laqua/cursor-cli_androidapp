import { posix } from 'node:path';

export function isSensitivePath(relativePath: string): boolean {
  const base = posix.basename(relativePath.replaceAll('\\', '/')).toLowerCase();
  return (
    base === '.env' ||
    base.startsWith('.env.') ||
    base.endsWith('.pem') ||
    base.endsWith('.key') ||
    base.startsWith('credentials') ||
    base.startsWith('secrets')
  );
}
