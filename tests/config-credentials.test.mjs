import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigManager, DEFAULT_CONFIG, mergeWithDefaults, deepMerge, getPath, setPath } from '../src/config/manager.mjs';
import { CredentialManager } from '../src/credentials/manager.mjs';
import { CredentialStoreError, normalizeKeyInput, validateKeyFormat } from '../src/credentials/storage.mjs';
import { maskKey, redactSecrets, titleFromPrompt, truncate } from '../src/util/text.mjs';
import { parseArgs } from '../src/cli/arguments.mjs';
import { paths } from '../src/config/paths.mjs';
import { tempDir, cleanupDir, setConfigDir, writeJson, readJson } from './helpers.mjs';

const KEY_ONE = 'nvapi-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_TWO = 'nvapi-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('credentials: pasted API keys lose terminal whitespace before validation', () => {
  // SSH/Android paste commonly adds CRLF or wraps the key; both used to leave
  // an invisible space that made a visually correct key fail authentication.
  assert.equal(normalizeKeyInput('nvapi-abcdefgh12345678\r\n'), 'nvapi-abcdefgh12345678');
  assert.equal(normalizeKeyInput('nvapi-abc def\tghi\n'), 'nvapi-abcdefghi');
  assert.equal(normalizeKeyInput('\u200bnvapi-abc\ufeff'), 'nvapi-abc');
  assert.deepEqual(validateKeyFormat(normalizeKeyInput('nvapi-abcdefgh12345678\n')), {
    ok: true,
    warning: null,
  });
});

test('config: defaults, nested updates and persistence', () => {
  const dir = setConfigDir(tempDir());
  try {
    const manager = new ConfigManager();
    const initial = manager.load();
    assert.equal(initial.setupComplete, false);
    assert.equal(initial.permissions.shell, 'ask');
    assert.equal(initial.defaultModel, DEFAULT_CONFIG.defaultModel);

    manager.setValue('workspace', '/tmp');
    manager.setValue('permissions.shell', 'allow');
    manager.setValue('agent.maxIterations', 7);
    manager.save();

    // Regression: nested defaults must not be shared with the saved config.
    assert.equal(DEFAULT_CONFIG.permissions.shell, 'ask');
    assert.equal(DEFAULT_CONFIG.agent.maxIterations, 20);

    const reloaded = new ConfigManager().load();
    assert.equal(reloaded.workspace, '/tmp');
    assert.equal(reloaded.permissions.shell, 'allow');
    assert.equal(reloaded.agent.maxIterations, 7);
    assert.equal(fs.statSync(paths.config()).mode & 0o777, 0o600);
  } finally {
    cleanupDir(dir);
  }
});

test('config: invalid values are normalised, corrupt files are preserved', () => {
  const dir = setConfigDir(tempDir());
  try {
    writeJson(paths.config(), {
      permissions: { shell: 'yolo' },
      agent: { maxIterations: 9999, commandTimeoutMs: 1 },
    });
    const config = new ConfigManager().load();
    assert.equal(config.permissions.shell, 'ask');
    assert.equal(config.permissions.fileWrite, 'ask');
    assert.equal(config.agent.maxIterations, 60);
    assert.equal(config.agent.commandTimeoutMs, 1000);

    fs.writeFileSync(paths.config(), '{ not json');
    const fallback = new ConfigManager().load();
    assert.equal(fallback.permissions.shell, 'ask');
    const backups = fs.readdirSync(dir).filter((file) => file.includes('.corrupt-'));
    assert.equal(backups.length, 1);
  } finally {
    cleanupDir(dir);
  }
});

test('config: merge and path helpers', () => {
  const merged = mergeWithDefaults({ ui: { streaming: false } });
  assert.equal(merged.ui.streaming, false);
  assert.equal(merged.ui.showActivity, true);
  const object = {};
  setPath(object, 'a.b.c', 42);
  assert.equal(getPath(object, 'a.b.c'), 42);
  assert.equal(getPath(object, 'missing.path'), undefined);
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 } }, { a: { b: 9 } }), { a: { b: 9, c: 2 } });
});

test('credentials: masking never reveals the key', () => {
  assert.equal(maskKey(KEY_ONE), 'nvapi-••••••••••••aaaa');
  assert.notEqual(maskKey(KEY_ONE), KEY_ONE);
  assert.equal(maskKey(''), '(none)');
  assert.equal(maskKey('short'), '••••••••••••');
});

test('credentials: add, switch, rename, remove, statuses', () => {
  const dir = setConfigDir(tempDir());
  try {
    const manager = new CredentialManager();
    const first = manager.add({ name: 'Personal', key: KEY_ONE });
    const second = manager.add({ name: 'Backup', key: KEY_TWO, status: 'ready' });
    assert.equal(manager.size, 2);
    assert.equal(manager.activeId, first.id);

    const listed = manager.list();
    const serialised = JSON.stringify(listed);
    assert.equal(serialised.includes(KEY_ONE), false);
    assert.equal(serialised.includes(KEY_TWO), false);
    assert.equal(listed[0].masked, 'nvapi-••••••••••••aaaa');

    manager.setActive(second.id);
    assert.equal(manager.activeEntry().name, 'Backup');
    assert.equal(manager.reveal(second.id), KEY_TWO);

    manager.rename(first.id, 'Laptop');
    assert.equal(manager.get(first.id).name, 'Laptop');

    manager.setStatus(first.id, 'rate_limited', 'HTTP 429');
    assert.equal(manager.get(first.id).status, 'rate_limited');

    manager.touch(first.id);
    assert.ok(manager.get(first.id).lastUsedAt > 0);

    manager.remove(second.id);
    assert.equal(manager.size, 1);
    assert.equal(manager.activeId, first.id);

    assert.equal(fs.statSync(paths.credentials()).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.dir()).mode & 0o777, 0o700);

    const reloaded = new CredentialManager();
    assert.equal(reloaded.size, 1);
    assert.equal(reloaded.activeEntry().name, 'Laptop');
  } finally {
    cleanupDir(dir);
  }
});

test('credentials: duplicate and malformed keys are rejected', () => {
  const dir = setConfigDir(tempDir());
  try {
    const manager = new CredentialManager();
    manager.add({ name: 'One', key: KEY_ONE });
    assert.throws(() => manager.add({ name: 'Dup', key: KEY_ONE }), /already stored/i);
    assert.throws(() => manager.add({ name: 'Bad', key: 'short' }), /too short/i);
    assert.throws(() => manager.add({ name: 'Bad', key: 'has space in it and is long enough' }), /whitespace/i);
    assert.deepEqual(validateKeyFormat(KEY_ONE), { ok: true, warning: null });
    assert.equal(validateKeyFormat('x'.repeat(30)).warning !== null, true);
    assert.equal(manager.findByKey(KEY_ONE).name, 'One');
  } finally {
    cleanupDir(dir);
  }
});

test('credentials: optional AES-256-GCM encryption at rest', () => {
  const dir = setConfigDir(tempDir());
  const previous = process.env.MIKUHOST_ENCRYPTION_KEY;
  try {
    process.env.MIKUHOST_ENCRYPTION_KEY = 'correct horse battery staple';
    const manager = new CredentialManager();
    manager.add({ name: 'Encrypted', key: KEY_ONE });

    const raw = fs.readFileSync(paths.credentials(), 'utf8');
    assert.match(raw, /"enc": "aes-256-gcm"/);
    assert.equal(raw.includes(KEY_ONE), false);

    const reader = new CredentialManager();
    assert.equal(reader.reveal(reader.activeId), KEY_ONE);

    delete process.env.MIKUHOST_ENCRYPTION_KEY;
    assert.throws(() => new CredentialManager(), CredentialStoreError);

    process.env.MIKUHOST_ENCRYPTION_KEY = 'wrong passphrase';
    assert.throws(() => new CredentialManager(), /Could not decrypt/);
  } finally {
    if (previous === undefined) delete process.env.MIKUHOST_ENCRYPTION_KEY;
    else process.env.MIKUHOST_ENCRYPTION_KEY = previous;
    cleanupDir(dir);
  }
});

test('text helpers: redaction and masking of secret-like strings', () => {
  const text = `key=${KEY_ONE} authorization: Bearer ${KEY_TWO} password=hunter2hunter2`;
  const redacted = redactSecrets(text);
  assert.equal(redacted.includes(KEY_ONE), false);
  assert.equal(redacted.includes(KEY_TWO), false);
  assert.match(redacted, /\[redacted\]/);
  assert.equal(titleFromPrompt('  fix   the   bot\nsecond line'), 'fix the bot');
  assert.equal(titleFromPrompt(''), 'New Session');
  assert.equal(truncate('abcdef', 4), 'abc…');
});

test('arguments: parses commands, flags and errors', () => {
  assert.deepEqual(parseArgs([]), {
    command: null,
    args: [],
    options: {},
    errors: [],
    help: false,
    version: false,
  });
  const withWorkspace = parseArgs(['--workspace', '/root', '--model', 'z-ai/glm-5.3-flash']);
  assert.equal(withWorkspace.options.workspace, '/root');
  assert.equal(withWorkspace.options.model, 'z-ai/glm-5.3-flash');
  assert.deepEqual(withWorkspace.errors, []);

  assert.equal(parseArgs(['--workspace=/srv']).options.workspace, '/srv');
  const doctor = parseArgs(['doctor']);
  assert.equal(doctor.command, 'doctor');
  const keyboard = parseArgs(['doctor', '--keyboard']);
  assert.equal(keyboard.command, 'doctor');
  assert.equal(keyboard.options.keyboard, true);
  assert.deepEqual(keyboard.errors, []);
  assert.equal(parseArgs(['--keyboard']).errors.length, 1);
  const keys = parseArgs(['keys', 'add', 'Work', KEY_ONE]);
  assert.equal(keys.command, 'keys');
  assert.deepEqual(keys.args, ['add', 'Work', KEY_ONE]);

  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-v']).version, true);
  assert.equal(parseArgs(['nonsense']).errors.length, 1);
  assert.equal(parseArgs(['--unknown']).errors.length, 1);
  assert.equal(parseArgs(['--workspace']).errors.length, 1);
});

test('credentials file is never written inside the workspace by accident', () => {
  const dir = setConfigDir(tempDir());
  try {
    const manager = new CredentialManager();
    manager.add({ name: 'One', key: KEY_ONE });
    const files = fs.readdirSync(dir);
    assert.deepEqual(files.sort(), ['credentials.json', 'logs']);
    const stored = readJson(path.join(dir, 'credentials.json'));
    assert.equal(stored.keys[0].key, KEY_ONE);
    assert.equal(fs.existsSync(paths.config()), false);
  } finally {
    cleanupDir(dir);
  }
});
