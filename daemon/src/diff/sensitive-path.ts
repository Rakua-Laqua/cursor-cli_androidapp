import { posix } from 'node:path';

export function isSensitivePath(relativePath: string): boolean {
  const base = posix.basename(relativePath.replaceAll('\\', '/')).toLowerCase();
  return (
    base === '.env' ||
    base.startsWith('.env.') ||
    base.endsWith('.pem') ||
    base.endsWith('.key') ||
    base.startsWith('credentials') ||
    base.startsWith('secrets') ||
    base === 'id_rsa' ||
    base === 'id_ed25519' ||
    base === 'id_ecdsa' ||
    base === 'id_dsa' ||
    base === '.netrc' ||
    base.endsWith('.p12') ||
    base.endsWith('.pfx')
  );
}
