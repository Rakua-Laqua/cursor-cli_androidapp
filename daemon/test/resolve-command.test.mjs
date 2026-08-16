import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolveAcpCommand,
  selectLatestAgentVersionDir,
  toSpawnableAcpCommand,
} from '../dist/index.js';

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

test('PATH fallback wraps Windows agent.cmd so it can be spawned without shell', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-path-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const cmdPath = path.join(bin, 'agent.cmd');
  fs.writeFileSync(cmdPath, '');

  const resolved = resolveAcpCommand(
    {
      LOCALAPPDATA: path.join(root, 'empty-local'),
      PATH: bin,
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    },
    'win32',
  );

  assert.equal(resolved.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(resolved.args, ['/d', '/c', cmdPath, 'acp']);
});

test('toSpawnableAcpCommand wraps .cmd and .bat on Windows', () => {
  const wrapped = toSpawnableAcpCommand('C:\\tools\\agent.cmd', ['acp'], 'win32', {
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  });
  assert.equal(wrapped.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(wrapped.args, ['/d', '/c', 'C:\\tools\\agent.cmd', 'acp']);

  const exe = toSpawnableAcpCommand('C:\\tools\\agent.exe', ['acp'], 'win32', {});
  assert.equal(exe.command, 'C:\\tools\\agent.exe');
  assert.deepEqual(exe.args, ['acp']);
});
