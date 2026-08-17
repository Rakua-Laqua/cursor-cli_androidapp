import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertDirectoryAllowed,
  freezeAllowedRoot,
  WorkspaceNotAllowedError,
  WorkspacePathError,
} from '../dist/index.js';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-root-'));
}

function tryDirLink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, 'dir');
    return true;
  } catch {
    try {
      fs.symlinkSync(target, linkPath, 'junction');
      return true;
    } catch {
      return false;
    }
  }
}

test('allowedRoot/project is allowed', () => {
  const allowedRoot = freezeAllowedRoot(makeRoot());
  const project = path.join(allowedRoot, 'project');
  fs.mkdirSync(project);
  assert.equal(assertDirectoryAllowed(project, [allowedRoot]), fs.realpathSync(project));
});

test('allowedRoot/project/src is allowed', () => {
  const allowedRoot = freezeAllowedRoot(makeRoot());
  const src = path.join(allowedRoot, 'project', 'src');
  fs.mkdirSync(src, { recursive: true });
  assert.equal(assertDirectoryAllowed(src, [allowedRoot]), fs.realpathSync(src));
});

test('allowedRoot/project/../other is allowed when still inside allowedRoot', () => {
  const allowedRoot = freezeAllowedRoot(makeRoot());
  const project = path.join(allowedRoot, 'project');
  const other = path.join(allowedRoot, 'other');
  fs.mkdirSync(project);
  fs.mkdirSync(other);
  const escaped = path.join(project, '..', 'other');
  assert.equal(assertDirectoryAllowed(escaped, [allowedRoot]), fs.realpathSync(other));
});

test('allowedRoot/project/../other is rejected when it leaves allowedRoot', () => {
  const parent = makeRoot();
  const allowedPath = path.join(parent, 'allowed');
  fs.mkdirSync(allowedPath);
  const allowedRoot = freezeAllowedRoot(allowedPath);
  const other = path.join(parent, 'other');
  const project = path.join(allowedRoot, 'project');
  fs.mkdirSync(project);
  fs.mkdirSync(other);
  const escaped = path.join(project, '..', '..', 'other');
  assert.throws(() => assertDirectoryAllowed(escaped, [allowedRoot]), WorkspaceNotAllowedError);
});

test('../../etc/passwd is rejected', () => {
  const allowedRoot = freezeAllowedRoot(makeRoot());
  assert.throws(
    () =>
      assertDirectoryAllowed(path.join(allowedRoot, '..', '..', 'etc', 'passwd'), [allowedRoot]),
    (error) => error instanceof WorkspaceNotAllowedError || error instanceof WorkspacePathError,
  );
});

test('symlink to a directory outside allowedRoot is rejected', () => {
  const allowedRoot = freezeAllowedRoot(makeRoot());
  const outside = makeRoot();
  const project = path.join(allowedRoot, 'project');
  fs.mkdirSync(project);
  const linkPath = path.join(project, 'escape');
  if (!tryDirLink(outside, linkPath)) {
    return;
  }
  assert.throws(() => assertDirectoryAllowed(linkPath, [allowedRoot]), WorkspaceNotAllowedError);
});

test('allowedRoot replaced with a symlink after freeze is not trusted', (t) => {
  const parent = makeRoot();
  const allowedPath = path.join(parent, 'allowed');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(allowedPath);
  fs.mkdirSync(outside);
  const frozen = freezeAllowedRoot(allowedPath);

  fs.renameSync(allowedPath, path.join(parent, 'allowed-old'));
  if (!tryDirLink(outside, allowedPath)) {
    t.skip('directory symlink/junction is not available');
    return;
  }

  const sneaky = path.join(allowedPath, 'project');
  fs.mkdirSync(sneaky);
  assert.throws(() => assertDirectoryAllowed(sneaky, [frozen]), WorkspaceNotAllowedError);
});

test('freezeAllowedRoot requires an existing directory', () => {
  const parent = makeRoot();
  const missing = path.join(parent, 'missing');
  const filePath = path.join(parent, 'notes.txt');
  fs.writeFileSync(filePath, 'x');
  assert.throws(() => freezeAllowedRoot(missing), WorkspacePathError);
  assert.throws(() => freezeAllowedRoot(filePath), WorkspacePathError);
});
