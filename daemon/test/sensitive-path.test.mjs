import assert from 'node:assert/strict';
import test from 'node:test';

import { isSensitivePath } from '../dist/index.js';

test('sensitive matcher is case-insensitive on basename patterns', () => {
  const sensitive = [
    '.env',
    '.ENV',
    '.env.local',
    '.Env.Production',
    'dir/.env',
    'src\\secrets.txt',
    'id.pem',
    'CERT.PEM',
    'id.key',
    'private.KEY',
    'credentials',
    'credentials.json',
    'CREDENTIALS-store',
    'secrets',
    'secrets.yaml',
    'SECRETS_TOKEN',
  ];
  for (const path of sensitive) {
    assert.equal(isSensitivePath(path), true, path);
  }

  const allowed = [
    'env',
    '.envrc',
    'readme.md',
    'id.key.backup',
    'pem.txt',
    'my-credentials-note.md',
    'nested/config.json',
  ];
  for (const path of allowed) {
    assert.equal(isSensitivePath(path), false, path);
  }
});
