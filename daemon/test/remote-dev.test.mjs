import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseRemoteDevArgv, RemoteDevUsageError, runRemoteDev } from '../dist/cli/remote-dev.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'mock-acp.mjs');
const cli = path.join(here, '..', 'dist', 'cli', 'remote-dev.js');

function mockFlags() {
  return ['--acp-command', process.execPath, '--acp-arg', fixture];
}

function makeDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function captureIo() {
  const stdout = [];
  const stderr = [];
  return {
    io: {
      stdout: {
        write(chunk) {
          stdout.push(chunk);
        },
      },
      stderr: {
        write(chunk) {
          stderr.push(chunk);
        },
      },
    },
    text() {
      return stdout.join('');
    },
    err() {
      return stderr.join('');
    },
  };
}

function joinedAssistantTextFromNdjson(text) {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === 'assistant.message')
    .map((event) => event.payload.text)
    .join('');
}

test('parseRemoteDevArgv maps workspace select and session send', () => {
  const selected = parseRemoteDevArgv(['workspace', 'select', '/tmp/project']);
  assert.deepEqual(selected.command, { kind: 'workspace.register', path: '/tmp/project' });

  const sent = parseRemoteDevArgv(['session', 'send', 'sess-1', 'hello', 'world']);
  assert.deepEqual(sent.command, {
    kind: 'session.send',
    remoteSessionId: 'sess-1',
    text: 'hello world',
  });

  const created = parseRemoteDevArgv([
    '--title',
    'Probe',
    '--prompt',
    'hi',
    'session',
    'create',
    'ws-1',
  ]);
  assert.deepEqual(created.command, {
    kind: 'session.create',
    workspaceId: 'ws-1',
    title: 'Probe',
    initialPrompt: 'hi',
  });

  const roots = [path.join(os.tmpdir(), 'a'), path.join(os.tmpdir(), 'b')];
  const fromEnv = parseRemoteDevArgv(['workspace', 'list'], {
    REMOTE_DEV_STATE_DIR: path.join(os.tmpdir(), 'state'),
    REMOTE_DEV_ALLOWED_ROOTS: roots.join(path.delimiter),
  });
  assert.equal(fromEnv.stateDir, path.join(os.tmpdir(), 'state'));
  assert.deepEqual(fromEnv.allowedRoots, roots);
});

test('one-shot session cancel is a usage error', async () => {
  const cap = captureIo();
  const code = await runRemoteDev(
    [
      ...mockFlags(),
      '--state-dir',
      makeDir('remote-dev-state-'),
      '--allowed-root',
      makeDir('remote-dev-root-'),
      'session',
      'cancel',
      'sess-1',
    ],
    cap.io,
    {},
  );
  assert.equal(code, 2);
  assert.match(cap.err(), /one-shot session cancel is not supported/);
  assert.doesNotMatch(cap.err(), /Unknown command/);
});

test('parseRemoteDevArgv rejects unknown commands and option mismatches', () => {
  assert.throws(() => parseRemoteDevArgv(['nope']), RemoteDevUsageError);
  assert.throws(() => parseRemoteDevArgv(['--acp-arg', 'x', 'workspace', 'list']), /--acp-command/);
  assert.throws(() => parseRemoteDevArgv(['--title', 'x', 'workspace', 'list']), /session create/);
  assert.throws(() => parseRemoteDevArgv(['--workspace', '/tmp/p', 'workspace', 'list']), /e2e/);
  assert.throws(
    () => parseRemoteDevArgv(['session', 'cancel', 'sess-1']),
    /one-shot session cancel is not supported/,
  );
});

test('one-shot commands require state-dir and allowed-root', async () => {
  const missingState = captureIo();
  assert.equal(await runRemoteDev(['workspace', 'list'], missingState.io, {}), 2);
  assert.match(missingState.err(), /state-dir/);

  const missingRoots = captureIo();
  const missingRootsCode = await runRemoteDev(
    ['--state-dir', makeDir('remote-dev-state-'), 'workspace', 'list'],
    missingRoots.io,
    {},
  );
  assert.equal(missingRootsCode, 2);
  assert.match(missingRoots.err(), /allowed-root/);
});

test('local e2e harness streams, cancels, restarts, loads, and continues', async () => {
  const cap = captureIo();
  const code = await runRemoteDev([...mockFlags(), 'e2e'], cap.io, {});
  assert.equal(code, 0, cap.err());
  const output = cap.text();
  assert.match(output, /workspace selected /);
  assert.match(output, /session created /);
  assert.match(output, /streamed E2ESTR_/);
  assert.match(output, /^cancelled$/m);
  assert.match(output, /^daemon restarted$/m);
  assert.match(output, /session loaded /);
  assert.match(output, /continued E2ECON_/);
  assert.match(output, /^e2e ok /m);
});

test('remote-dev one-shot commands can select a workspace, create, send, and list', async () => {
  const stateDir = makeDir('remote-dev-state-');
  const allowedRoot = makeDir('remote-dev-root-');
  const project = path.join(allowedRoot, 'app');
  fs.mkdirSync(project);
  const flags = [...mockFlags(), '--state-dir', stateDir, '--allowed-root', allowedRoot, '--json'];

  const select = captureIo();
  assert.equal(await runRemoteDev([...flags, 'workspace', 'select', project], select.io), 0);
  const registered = JSON.parse(select.text());
  assert.equal(registered.name, 'app');

  const listedWorkspaces = captureIo();
  assert.equal(await runRemoteDev([...flags, 'workspace', 'list'], listedWorkspaces.io), 0);
  assert.equal(JSON.parse(listedWorkspaces.text()).length, 1);

  const createdCap = captureIo();
  assert.equal(
    await runRemoteDev(
      [...flags, 'session', 'create', registered.workspaceId, '--title', 'cli'],
      createdCap.io,
    ),
    0,
  );
  const created = JSON.parse(createdCap.text());
  assert.equal(created.title, 'cli');
  assert.equal(created.status, 'idle');

  const sendCap = captureIo();
  const sendCode = await runRemoteDev(
    [...flags, 'session', 'send', created.remoteSessionId, 'hello-cli'],
    sendCap.io,
  );
  assert.equal(sendCode, 0, sendCap.err());
  assert.equal(joinedAssistantTextFromNdjson(sendCap.text()), 'echo:hello-cli');
  assert.match(sendCap.text(), /"delta":true/);

  const listCap = captureIo();
  const listCode = await runRemoteDev(
    [...flags, 'session', 'list', registered.workspaceId],
    listCap.io,
  );
  assert.equal(listCode, 0);
  const sessions = JSON.parse(listCap.text());
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].remoteSessionId, created.remoteSessionId);
  assert.equal(sessions[0].status, 'completed');
});

test('remote-dev CLI process completes the e2e loop against mock ACP', () => {
  const result = spawnSync(process.execPath, [cli, ...mockFlags(), 'e2e'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /streamed E2ESTR_/);
  assert.match(result.stdout, /continued E2ECON_/);
  assert.match(result.stdout, /^e2e ok /m);
});
