// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, cleanupDir, setConfigDir } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'mikuhost.mjs');

function run(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
}

test('cli: --version and --help', () => {
  const version = run(['--version']);
  assert.equal(version.status, 0);
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  assert.equal(version.stdout.trim(), pkg.version);

  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /mikuhost doctor/);

  const bad = run(['--nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown option/);
});

test('cli: keys add/list/use/rename/remove never print the raw key', () => {
  const dir = tempDir('mikuhost-cli-keys-');
  try {
    const env = { MIKUHOST_CONFIG_DIR: dir };
    const key = 'nvapi-cli-test-key-1234567890abcdef';

    const add = run(['keys', 'add', 'Work', key], env);
    assert.equal(add.status, 0, add.stderr);
    assert.match(add.stdout, /Added Work/);
    assert.equal(add.stdout.includes(key), false);

    const list = run(['keys'], env);
    assert.equal(list.status, 0);
    assert.match(list.stdout, /API KEYS/);
    assert.match(list.stdout, /NVIDIA/);
    assert.match(list.stdout, /Work/);
    assert.match(list.stdout, /nvapi-••••/);
    assert.equal(list.stdout.includes(key), false);

    const rename = run(['keys', 'rename', 'Work', 'Laptop'], env);
    assert.equal(rename.status, 0);
    assert.match(rename.stdout, /Laptop/);

    const second = 'nvapi-second-key-1234567890abcdef';
    assert.equal(run(['keys', 'add', 'Backup', second], env).status, 0);
    const use = run(['keys', 'use', 'Backup'], env);
    assert.equal(use.status, 0);
    assert.match(use.stdout, /Active key: Backup/);

    const remove = run(['keys', 'remove', 'Laptop'], env);
    assert.equal(remove.status, 0);
    assert.match(remove.stdout, /Removed Laptop/);

    const invalid = run(['keys', 'add', 'Bad', 'short'], env);
    assert.equal(invalid.status, 2);

    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'));
    assert.equal(stored.keys.length, 1);
    assert.equal(stored.keys[0].name, 'Backup');
    assert.equal(fs.statSync(path.join(dir, 'credentials.json')).mode & 0o777, 0o600);
  } finally {
    cleanupDir(dir);
  }
});

test('cli: doctor --keyboard explains the non-TTY limitation', () => {
  const dir = tempDir('mikuhost-cli-keyboard-');
  try {
    const result = run(['doctor', '--keyboard'], { MIKUHOST_CONFIG_DIR: dir });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /KEYBOARD DIAGNOSTIC/);
    assert.match(result.stdout, /needs an interactive terminal/);
  } finally {
    cleanupDir(dir);
  }
});

test('cli: models and sessions output', () => {
  const dir = tempDir('mikuhost-cli-list-');
  try {
    const env = { MIKUHOST_CONFIG_DIR: dir };
    const models = run(['models'], env);
    assert.equal(models.status, 0);
    assert.match(models.stdout, /MODELS/);
    assert.match(models.stdout, /z-ai\/glm-5\.3-flash/);
    assert.match(models.stdout, /GLM 5\.3 Flash/);
    assert.match(models.stdout, /tools unverified/);

    const sessions = run(['sessions'], env);
    assert.equal(sessions.status, 0);
    assert.match(sessions.stdout, /No saved sessions yet/);
  } finally {
    cleanupDir(dir);
  }
});

test('cli: doctor reports environment without leaking credentials', () => {
  const dir = tempDir('mikuhost-cli-doctor-');
  try {
    const env = { MIKUHOST_CONFIG_DIR: dir };
    const result = run(['doctor'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MIKUHOST DOCTOR/);
    assert.match(result.stdout, /Node\.js/);
    assert.match(result.stdout, /SQLite/);
    assert.match(result.stdout, /Workspace/);
    assert.match(result.stdout, /Session database/);
    assert.match(result.stdout, /API keys/);
    assert.match(result.stdout, /Active provider/);
  } finally {
    cleanupDir(dir);
  }
});

test('cli: interactive mode refuses to start without a TTY', () => {
  const dir = tempDir('mikuhost-cli-tty-');
  try {
    const result = run([], { MIKUHOST_CONFIG_DIR: dir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs a TTY/);
  } finally {
    cleanupDir(dir);
  }
});

test('cli: invalid workspace fails cleanly', () => {
  const dir = tempDir('mikuhost-cli-ws-');
  try {
    const result = run(['--workspace', path.join(dir, 'missing')], { MIKUHOST_CONFIG_DIR: dir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Workspace error/);
  } finally {
    cleanupDir(dir);
  }
});

test('cli: config directory permissions are tightened', () => {
  const dir = tempDir('mikuhost-cli-perms-');
  try {
    fs.chmodSync(dir, 0o755);
    setConfigDir(dir);
    const result = run(['keys'], { MIKUHOST_CONFIG_DIR: dir });
    assert.equal(result.status, 0);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(dir, 'logs')), true);
  } finally {
    cleanupDir(dir);
  }
});
