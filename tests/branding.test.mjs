// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CREDIT_FILE,
  CreditIntegrityError,
  agentName,
  credit,
  creditFooter,
  decryptCreditPayload,
  developerName,
  productName,
} from '../src/branding/credit.mjs';
import { USAGE } from '../src/cli/arguments.mjs';
import { buildHeaderLines } from '../src/ui/text-layout.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
// Assembled from pieces so this test file keeps exactly one watermark itself.
const WATERMARK = ['// MikuHost Agent — © 2026 miku208', '— All rights reserved.'].join(' ');
const BIN = path.join(ROOT, 'bin', 'mikuhost.mjs');

test('branding: the encrypted credit decrypts to the developer attribution', () => {
  const info = credit();
  assert.equal(info.product, 'MikuHost');
  assert.equal(info.agent, 'MikuHost Agent');
  assert.equal(info.dev, 'miku208');
  assert.match(info.notice, /not for sale|may not be resold/i);
  assert.equal(productName(), info.product);
  assert.equal(agentName(), info.agent);
  assert.equal(developerName(), info.dev);
  assert.match(creditFooter(), /miku208/);
});

test('branding: the credit file is encrypted, not plain text', () => {
  const raw = fs.readFileSync(CREDIT_FILE, 'utf8');
  assert.equal(/miku208|MikuHost Agent|not for sale/i.test(raw), false, 'the credit must not be readable');
  const payload = JSON.parse(raw);
  assert.equal(payload.alg, 'aes-256-gcm');
  assert.ok(payload.iv && payload.tag && payload.data);
});

test('branding: a tampered credit payload fails the integrity check', () => {
  const payload = JSON.parse(fs.readFileSync(CREDIT_FILE, 'utf8'));
  const flipped = { ...payload, data: `${payload.data.slice(0, -4)}AAAA` };
  assert.throws(() => decryptCreditPayload(flipped), CreditIntegrityError);
  assert.throws(() => decryptCreditPayload({ ...payload, alg: 'none' }), CreditIntegrityError);
});

test('branding: the CLI and the TUI header take the name from the credit', () => {
  assert.match(USAGE.split('\n')[0], new RegExp(agentName()));
  assert.match(USAGE, /miku208/, 'the help text must keep the developer credit');
  const header = buildHeaderLines({ width: 80 }).map((line) => line.text).join('\n');
  assert.match(header, new RegExp(agentName().toUpperCase()));
});

test('branding: every source file carries the watermark', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(rel);
      } else if (entry.name.endsWith('.mjs')) {
        files.push(rel);
      }
    }
  };
  for (const dir of ['src', 'bin', 'scripts', 'tests']) walk(dir);
  assert.ok(files.length > 50, `expected the whole tree, found ${files.length} files`);
  const missing = files.filter((rel) => {
    // The first line may be a shebang; the notice must be the next line.
    const head = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').slice(0, 2);
    return !head.includes(WATERMARK);
  });
  assert.deepEqual(missing, [], `files without the watermark: ${missing.join(', ')}`);
  const doubled = files.filter(
    (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').split(WATERMARK).length - 1 !== 1,
  );
  assert.deepEqual(doubled, [], `files with a duplicated watermark: ${doubled.join(', ')}`);
});

test('branding: a build without the encrypted credit refuses to run', () => {
  const source = fs.readFileSync(CREDIT_FILE, 'utf8');
  const backup = `${CREDIT_FILE}.test-backup`;
  fs.renameSync(CREDIT_FILE, backup);
  try {
    const run = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /credit file is missing/i);
  } finally {
    fs.renameSync(backup, CREDIT_FILE);
  }
  assert.equal(fs.readFileSync(CREDIT_FILE, 'utf8'), source, 'the real payload must be restored untouched');
});
