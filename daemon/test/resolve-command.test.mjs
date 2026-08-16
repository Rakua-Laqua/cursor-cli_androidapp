import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveAcpCommand, selectLatestAgentVersionDir } from '../dist/index.js';

test('selectLatestAgentVersionDir prefers the newest dated Cursor agent version', () => {
  assert.equal(
    selectLatestAgentVersionDir([
      'not-a-version',
      '2026.07.23-e383d2b',
      '2026.08.11-e8db854',
      '2026.8.1-aaaaaaa',
    ]),
    '2026.08.11-e8db854',
  );
});

test('resolveAcpCommand uses the latest node.exe + index.js acp launch on Windows installs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-resolve-'));
  const older = path.join(root, 'cursor-agent', 'versions', '2026.07.23-e383d2b');
  const newer = path.join(root, 'cursor-agent', 'versions', '2026.08.11-e8db854');
  fs.mkdirSync(older, { recursive: true });
  fs.mkdirSync(newer, { recursive: true });
  fs.writeFileSync(path.join(older, 'node.exe'), '');
  fs.writeFileSync(path.join(older, 'index.js'), '');
  fs.writeFileSync(path.join(newer, 'node.exe'), '');
  fs.writeFileSync(path.join(newer, 'index.js'), '');

  const resolved = resolveAcpCommand({
    LOCALAPPDATA: root,
    PATH: '',
  });

  assert.equal(resolved.command, path.join(newer, 'node.exe'));
  assert.deepEqual(resolved.args, [path.join(newer, 'index.js'), 'acp']);
});
