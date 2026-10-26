// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { paths, ensureConfigDir } from '../config/paths.mjs';
import { readJson, writeJsonAtomic } from '../util/atomic.mjs';
import { detectProviderFromKey, getProvider, providerName, resolveProviderId } from '../providers/catalog.mjs';

/**
 * Credential file format (plaintext):
 *   { version: 1, activeId: "k_ab12", keys: [{ id, name, key, provider, ... }] }
 *
 * `provider` records which service the key belongs to (nvidia, tokenharbor,
 * custom). Old files without it are read as NVIDIA keys.
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
          provider: entry.provider ? resolveProviderId(entry.provider) : detectProviderFromKey(entry.key) ?? resolveProviderId(null),
          baseUrl: typeof entry.baseUrl === 'string' && entry.baseUrl ? entry.baseUrl.replace(/\/+$/, '') : null,
          model: typeof entry.model === 'string' && entry.model ? entry.model : null,
          source: 'stored',
          createdAt: Number(entry.createdAt) || Date.now(),
          lastUsedAt: Number(entry.lastUsedAt) || null,
          status: ['ready', 'unverified', 'invalid', 'rate_limited', 'blocked'].includes(entry.status) ? entry.status : 'unverified',
          lastError: typeof entry.lastError === 'string' ? entry.lastError : null,
        }))
    : [];
  // An env-provided credential is never written to disk, but it can stay
  // active across saves.
  const envActive = typeof store.activeId === 'string' && store.activeId.startsWith('env:');
  const activeId = keys.some((k) => k.id === store.activeId) || envActive ? store.activeId : (keys[0]?.id ?? null);
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

/**
 * Remove bytes that can never be part of an API key. Terminal paste often adds
 * a trailing newline or wraps a copied key across lines; keeping that
 * whitespace produced a key that looked right but failed authentication.
 */
export function normalizeKeyInput(value) {
  return String(value ?? '').replace(/[\s\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g, '');
}

/**
 * Basic structural validation. Never logs the value.
 *
 * With `provider`, the prefix check is provider-specific; without it the
 * provider is detected from the key itself and an unrecognised prefix only
 * produces a warning (gateways and proxies often use their own format).
 */
export function validateKeyFormat(key, { provider = null } = {}) {
  const value = String(key ?? '').trim();
  if (!value) return { ok: false, reason: 'API key is empty.' };
  if (/\s/.test(value)) return { ok: false, reason: 'API key must not contain whitespace.' };
  if (value.length < 20) return { ok: false, reason: 'API key looks too short.' };
  const id = provider ? resolveProviderId(provider) : detectProviderFromKey(value);
  if (id) {
    const known = getProvider(id);
    const matches = (known?.keyPrefixes ?? []).some((prefix) => value.toLowerCase().startsWith(prefix));
    return {
      ok: true,
      warning: matches
        ? null
        : `This key does not look like a ${providerName(id)} key${known?.keyPrefixes.length ? ` (expected ${known.keyPrefixes.join(' / ')})` : ''}.`,
    };
  }
  return {
    ok: true,
    warning: 'This key does not match a known provider prefix; it will be stored for the active provider.',
  };
}
