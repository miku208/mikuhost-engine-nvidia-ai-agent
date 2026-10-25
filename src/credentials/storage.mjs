import fs from 'node:fs';
import crypto from 'node:crypto';
import { paths, ensureConfigDir } from '../config/paths.mjs';
import { readJson, writeJsonAtomic } from '../util/atomic.mjs';

/**
 * Credential file format (plaintext):
 *   { version: 1, activeId: "k_ab12", keys: [{ id, name, key, createdAt, ... }] }
 *
 * If MIKUHOST_ENCRYPTION_KEY is set the whole document is wrapped in an
 * AES-256-GCM envelope keyed by scrypt(passphrase, random salt). The salt lives
 * in the envelope, the passphrase never touches disk.
 *
 * The file itself is always created with mode 0600 inside a 0700 directory.
 */

const ENVELOPE_VERSION = 1;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export class CredentialStoreError extends Error {
  constructor(message, code = 'CREDENTIAL_STORE') {
    super(message);
    this.name = 'CredentialStoreError';
    this.code = code;
  }
}

function encryptionSecret() {
  const value = process.env.MIKUHOST_ENCRYPTION_KEY;
  return value && value.length > 0 ? value : null;
}

export function isEncryptedDocument(raw) {
  return Boolean(raw && typeof raw === 'object' && raw.enc === 'aes-256-gcm');
}

function deriveKey(secret, salt) {
  return crypto.scryptSync(secret, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

export function encryptDocument(document, secret) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(secret, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(document), 'utf8'), cipher.final()]);
  return {
    v: ENVELOPE_VERSION,
    enc: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('base64'),
  };
}

export function decryptDocument(envelope, secret) {
  try {
    const salt = Buffer.from(envelope.salt, 'hex');
    const iv = Buffer.from(envelope.iv, 'hex');
    const tag = Buffer.from(envelope.tag, 'hex');
    const key = deriveKey(secret, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const data = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    return JSON.parse(data.toString('utf8'));
  } catch {
    throw new CredentialStoreError(
      'Could not decrypt credentials.json. Set the same MIKUHOST_ENCRYPTION_KEY you used when saving them.',
      'DECRYPT_FAILED',
    );
  }
}

export function emptyStore() {
  return { version: 1, activeId: null, keys: [] };
}

export function loadCredentialStore(file = paths.credentials()) {
  const raw = readJson(file, null);
  if (!raw) return emptyStore();
  if (isEncryptedDocument(raw)) {
    const secret = encryptionSecret();
    if (!secret) {
      throw new CredentialStoreError(
        'credentials.json is encrypted but MIKUHOST_ENCRYPTION_KEY is not set.',
        'NO_ENCRYPTION_KEY',
      );
    }
    return normalizeStore(decryptDocument(raw, secret));
  }
  return normalizeStore(raw);
}

export function normalizeStore(store) {
  const base = emptyStore();
  if (!store || typeof store !== 'object') return base;
  const keys = Array.isArray(store.keys)
    ? store.keys
        .filter((entry) => entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key)
        .map((entry, index) => ({
          id: typeof entry.id === 'string' && entry.id ? entry.id : `k_${index + 1}`,
          name: typeof entry.name === 'string' && entry.name ? entry.name : `Key ${index + 1}`,
          key: entry.key.trim(),
          createdAt: Number(entry.createdAt) || Date.now(),
          lastUsedAt: Number(entry.lastUsedAt) || null,
          status: ['ready', 'unverified', 'invalid', 'rate_limited'].includes(entry.status) ? entry.status : 'unverified',
          lastError: typeof entry.lastError === 'string' ? entry.lastError : null,
        }))
    : [];
  const activeId = keys.some((k) => k.id === store.activeId) ? store.activeId : (keys[0]?.id ?? null);
  return { version: 1, activeId, keys };
}

export function saveCredentialStore(store, file = paths.credentials()) {
  ensureConfigDir();
  const normalized = normalizeStore(store);
  const secret = encryptionSecret();
  const payload = secret ? encryptDocument(normalized, secret) : normalized;
  writeJsonAtomic(file, payload, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
  return normalized;
}

/** Basic structural validation. Never logs the value. */
export function validateKeyFormat(key) {
  const value = String(key ?? '').trim();
  if (!value) return { ok: false, reason: 'API key is empty.' };
  if (/\s/.test(value)) return { ok: false, reason: 'API key must not contain whitespace.' };
  if (value.length < 20) return { ok: false, reason: 'API key looks too short.' };
  return {
    ok: true,
    warning: value.startsWith('nvapi-') ? null : 'This key does not start with "nvapi-"; it may not be an NVIDIA API key.',
  };
}
