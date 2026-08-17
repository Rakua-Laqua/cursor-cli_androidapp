import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseRemoteCommand, serializeCommand } from '@cursor-remote/protocol';

import {
  Daemon,
  WorkspaceNotAllowedError,
  WorkspaceNotFoundError,
  WorkspacePathError,
} from '../dist/index.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-acp.mjs');

function mockLaunch() {
  return {
    command: process.execPath,
    args: [fixture],
  };
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-mgr-'));
}

function gitOk() {
  return spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

async function withDaemon(allowedRoots, fn) {
  const daemon = await Daemon.start({
    acp: {
      ...mockLaunch(),
      shutdownTimeoutMs: 1000,
    },
    workspaces: { allowedRoots },
  });
  try {
    await fn(daemon);
  } finally {
    await daemon.stop();
  }
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('workspace.register rejects a path outside allowedRoots', async () => {
  const allowedRoot = makeRoot();
  const outside = makeRoot();
  await withDaemon([allowedRoot], async (daemon) => {
    assert.throws(() => daemon.workspaces.register(outside), WorkspaceNotAllowedError);
  });
});

test('workspace.register rejects a file that is not a directory', async () => {
  const allowedRoot = makeRoot();
  const filePath = path.join(allowedRoot, 'notes.txt');
  fs.writeFileSync(filePath, 'x');
  await withDaemon([allowedRoot], async (daemon) => {
    assert.throws(() => daemon.workspaces.register(filePath), WorkspacePathError);
  });
});

test('workspace.register and list expose git metadata and lastUsedAt', async () => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'my-app');
  fs.mkdirSync(project);

  if (gitOk()) {
    git(project, ['init']);
    git(project, ['config', 'user.email', 'task103@example.com']);
    git(project, ['config', 'user.name', 'task103']);
    fs.writeFileSync(path.join(project, 'README.md'), 'hello\n');
    git(project, ['add', 'README.md']);
    git(project, ['commit', '-m', 'init']);
    fs.writeFileSync(path.join(project, 'README.md'), 'dirty\n');
  }

  await withDaemon([allowedRoot], async (daemon) => {
    const events = [];
    daemon.workspaces.onEvent((event) => events.push(event));
    const registered = daemon.workspaces.register(project);
    assert.equal(registered.name, 'my-app');
    assert.equal(registered.path, fs.realpathSync(project));
    assert.equal(registered.activeSessionCount, 0);
    assert.equal(registered.lastUsedAt, null);
    if (gitOk()) {
      assert.equal(typeof registered.gitBranch, 'string');
      assert.equal(registered.modified, true);
    } else {
      assert.equal(registered.gitBranch, null);
      assert.equal(registered.modified, false);
    }
    assert.ok(events.some((event) => event.type === 'workspace.updated'));

    const again = daemon.workspaces.register(project);
    assert.equal(again.workspaceId, registered.workspaceId);

    const listed = daemon.workspaces.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].workspaceId, registered.workspaceId);
  });
});

test('handleCommand covers workspace.register and workspace.list', async () => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'backend');
  fs.mkdirSync(project);
  await withDaemon([allowedRoot], async (daemon) => {
    const registered = await daemon.handleCommand(
      parseRemoteCommand(
        serializeCommand({
          requestId: 'req-reg',
          sessionId: null,
          timestamp: new Date().toISOString(),
          type: 'workspace.register',
          payload: { path: project },
        }),
      ),
    );
    assert.ok(registered);
    assert.equal(registered.name, 'backend');

    const listed = await daemon.handleCommand(
      parseRemoteCommand(
        serializeCommand({
          requestId: 'req-list',
          sessionId: null,
          timestamp: new Date().toISOString(),
          type: 'workspace.list',
          payload: {},
        }),
      ),
    );
    assert.ok(Array.isArray(listed));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].workspaceId, registered.workspaceId);
  });
});

test('session.create requires a registered workspaceId and updates last-used metadata', async () => {
  const allowedRoot = makeRoot();
  const project = path.join(allowedRoot, 'app');
  fs.mkdirSync(project);
  await withDaemon([allowedRoot], async (daemon) => {
    await assert.rejects(
      () =>
        daemon.sessions.create({
          workspaceId: 'missing',
          initialPrompt: '',
          title: null,
        }),
      WorkspaceNotFoundError,
    );

    const registered = daemon.workspaces.register(project);
    const created = await daemon.sessions.create({
      workspaceId: registered.workspaceId,
      initialPrompt: '',
      title: 'probe',
    });
    assert.equal(created.workspaceId, registered.workspaceId);

    const listed = daemon.workspaces.list();
    assert.equal(listed[0].lastUsedAt !== null, true);
    assert.equal(listed[0].activeSessionCount, 0);

    const sending = daemon.sessions.send(created.remoteSessionId, 'DELAY');
    await waitUntil(() => daemon.workspaces.list()[0]?.activeSessionCount === 1);
    await daemon.sessions.cancel(created.remoteSessionId);
    await sending;
    assert.equal(daemon.workspaces.list()[0].activeSessionCount, 0);
  });
});
