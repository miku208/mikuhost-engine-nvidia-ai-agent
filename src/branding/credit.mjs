// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
/**
 * Developer credit, stored encrypted in `credit.enc`.
 *
 * The product name, the author and the "not for resale" notice live only in
 * that payload: the CLI usage text and the terminal header read them from here.
 * Delete or edit the encrypted file and the app refuses to start instead of
 * silently shipping without its author — the off switch is `assertCredit()` in
 * bin/mikuhost.mjs.
 *
 * This is copy protection, not military cryptography: the key below has to ship
 * with an offline CLI, so it is masked rather than secret. It raises the cost of
 * a casual "strip the credit" edit; it cannot stop a determined reader.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CREDIT_FILE = path.join(here, 'credit.enc');

const MASK = 0x5a;
// The 32-byte AES key, XOR-masked and split so it is not a single greppable blob.
const KEY_PARTS = ['ef62dfb32c116541', '29614cc53c0f5e52', '231365fd16f2defe', '462258f46ad02b5b'];

export class CreditIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CreditIntegrityError';
    this.code = 'CREDIT_INTEGRITY';
  }
}

let cached = null;

function keyBytes() {
  const bytes = Buffer.from(KEY_PARTS.join(''), 'hex');
  for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= MASK;
  return bytes;
}

/**
 * Decrypt and validate one payload. Exported so the integrity check can be
 * tested without touching the shipped file.
 */
export function decryptCreditPayload(payload) {
  try {
    if (payload?.alg !== 'aes-256-gcm') throw new Error('unsupported payload');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
    const parsed = JSON.parse(plain.toString('utf8'));
    if (!parsed?.product || !parsed?.dev) throw new Error('incomplete payload');
    return parsed;
  } catch {
    throw new CreditIntegrityError(
      'The developer credit file failed its integrity check. Reinstall MikuHost Agent from an official source.',
    );
  }
}

/** The developer credit. Throws when the encrypted payload is missing or tampered with. */
export function credit() {
  if (cached) return cached;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(CREDIT_FILE, 'utf8'));
  } catch (error) {
    throw new CreditIntegrityError(
      `The developer credit file is missing or unreadable (${error?.code ?? error?.message}). Reinstall MikuHost Agent from an official source.`,
    );
  }
  cached = decryptCreditPayload(payload);
  return cached;
}

/** Product name as it appears in the CLI and the header. */
export function productName() {
  return credit().product;
}

/** Agent title, e.g. "MikuHost Agent". */
export function agentName() {
  return credit().agent;
}

/** Author attribution, e.g. "miku208". */
export function developerName() {
  return credit().dev;
}

/** Two-line footer used by `--help` and the UI. */
export function creditFooter() {
  const info = credit();
  return `${info.agent} · ${info.dev} · ${info.repo}\n${info.notice}`;
}

/** Startup guard: a distribution without its credit is not a valid build. */
export function assertCredit() {
  return credit();
}
