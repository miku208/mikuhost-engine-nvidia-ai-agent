// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import crypto from 'node:crypto';
import { paths } from '../config/paths.mjs';
import { maskKey } from '../util/text.mjs';
import { credentialsFromEnv, detectProviderFromKey, providerName, resolveProviderId } from '../providers/catalog.mjs';
import {
  loadCredentialStore,
  saveCredentialStore,
  validateKeyFormat,
  CredentialStoreError,
} from './storage.mjs';

export class CredentialError extends Error {
  constructor(message, code = 'CREDENTIAL') {
    super(message);
    this.name = 'CredentialError';
    this.code = code;
  }
}

const ENV_ID_PREFIX = 'env:';

/**
 * Manages API keys for multiple providers.
 *
 * Tokens supplied through the environment (NVIDIA_API_KEY, TOKENHARBOR_API_KEY,
 * MIKUHOST_API_KEY) are auto-detected on construction. They are exposed as
 * read-only entries so the agent can use them immediately, but they are never
 * copied into credentials.json: removing the variable removes the key.
 *
 * Plaintext key material only ever leaves this module through `activeKey()`
 * (to the provider) and `reveal()` (used by the validation step). Everything
 * the UI sees is masked.
 */
export class CredentialManager {
  constructor({ file = paths.credentials(), store = null, env = process.env } = {}) {
    this.file = file;
    this.store = store ?? loadCredentialStore(file);
    this.env = env;
    this.envEntries = this.detectEnvEntries();
    /** Key chosen by the user for the next request only (never persisted). */
    this.preferredId = null;
  }

  detectEnvEntries() {
    return credentialsFromEnv(this.env).map((found) => ({
      id: `${ENV_ID_PREFIX}${found.provider}`,
      name: `${providerName(found.provider)} (env)`,
      key: found.key,
      provider: found.provider,
      baseUrl: found.baseUrl,
      model: found.model,
      source: 'env',
      createdAt: 0,
      lastUsedAt: null,
      status: 'unverified',
      lastError: null,
    }));
  }

  reload() {
    this.store = loadCredentialStore(this.file);
    this.envEntries = this.detectEnvEntries();
    return this;
  }

  persist() {
    this.store = saveCredentialStore(this.store, this.file);
    return this;
  }

  /** Stored keys first, then environment-supplied keys. */
  entries() {
    return [...this.store.keys, ...this.envEntries];
  }

  /**
   * Provider a key really belongs to. The key prefix is authoritative, so a
   * token pasted under the wrong provider is never sent to that service.
   */
  providerOf(entry) {
    if (!entry) return resolveProviderId(null);
    return detectProviderFromKey(entry.key) ?? resolveProviderId(entry.provider);
  }

  /** Providers that have at least one key, validated by prefix. */
  providers() {
    return Array.from(new Set(this.entries().map((entry) => this.providerOf(entry))));
  }

  list() {
    return this.entries().map((entry) => ({
      id: entry.id,
      name: entry.name,
      masked: maskKey(entry.key),
      provider: this.providerOf(entry),
      providerName: providerName(this.providerOf(entry)),
      baseUrl: entry.baseUrl ?? null,
      model: entry.model ?? null,
      source: entry.source === 'env' ? 'env' : 'stored',
      active: entry.id === this.activeId,
      status: entry.status,
      lastUsedAt: entry.lastUsedAt,
      lastError: entry.lastError,
      createdAt: entry.createdAt,
    }));
  }

  get size() {
    return this.entries().length;
  }

  get activeId() {
    const stored = this.store.keys.some((entry) => entry.id === this.store.activeId);
    if (stored) return this.store.activeId;
    if (this.envEntries.some((entry) => entry.id === this.store.activeId)) return this.store.activeId;
    return this.envEntries[0]?.id ?? this.store.activeId ?? null;
  }

  get(id) {
    return this.entries().find((entry) => entry.id === id) ?? null;
  }

  activeEntry() {
    return this.get(this.activeId);
  }

  activeKey() {
    return this.activeEntry()?.key ?? null;
  }

  /** Provider of the key that will be used for the next request. */
  get activeProvider() {
    return this.providerOf(this.activeEntry());
  }

  /**
   * Credential for one provider.
   *
   * Every candidate is validated first: only keys whose own prefix belongs to
   * that provider. With more than one eligible key the choice is random, so
   * parallel/rotated keys share the load; a key picked with setActive() keeps
   * the next request. Keys marked invalid are skipped unless every key of that
   * provider is invalid.
   */
  pickForProvider(providerId, { random = Math.random } = {}) {
    const id = resolveProviderId(providerId);
    const owned = this.entries().filter((entry) => this.providerOf(entry) === id);
    if (!owned.length) return null;
    // Keys marked INVALID are skipped, but if they are the only ones left a
    // request is still attempted: the status may be stale, and the provider's
    // own error is more useful than "no key configured".
    const healthy = owned.filter((entry) => entry.status !== 'invalid');
    const candidates = healthy.length ? healthy : owned;

    const pinned = candidates.find((entry) => entry.id === this.preferredId);
    if (pinned) {
      this.preferredId = null;
      return pinned;
    }

    // A blocked key (403: verify email, missing model access) is known to fail
    // right now, so it sits with rate_limited behind keys that can still work.
    const rank = { ready: 0, unverified: 1, rate_limited: 2, blocked: 2 };
    const best = Math.min(...candidates.map((entry) => rank[entry.status] ?? 1));
    const pool = candidates.filter((entry) => (rank[entry.status] ?? 1) === best);
    if (pool.length === 1) return pool[0];
    const roll = Math.max(0, Math.min(1, Number(random()) || 0));
    return pool[Math.min(pool.length - 1, Math.floor(roll * pool.length))];
  }

  /** Remember which key served a request, without writing it to disk. */
  markUsed(id) {
    if (this.get(id)) this.store.activeId = id;
  }

  /** First key (stored or from the environment) that belongs to `provider`. */
  firstForProvider(providerId) {
    const id = resolveProviderId(providerId);
    return this.entries().find((entry) => this.providerOf(entry) === id) ?? null;
  }

  /** Only used right before sending a request; never rendered. */
  reveal(id) {
    return this.get(id)?.key ?? null;
  }

  findByKey(key) {
    const value = String(key ?? '').trim();
    return this.entries().find((entry) => entry.key === value) ?? null;
  }

  add({ name, key, provider = null, baseUrl = null, model = null, status = 'unverified' } = {}) {
    const trimmed = String(key ?? '').trim();
    const resolved = provider ? resolveProviderId(provider) : detectProviderFromKey(trimmed) ?? resolveProviderId(null);
    const check = validateKeyFormat(trimmed, { provider: resolved });
    if (!check.ok) throw new CredentialError(check.reason, 'INVALID_KEY_FORMAT');
    if (this.entries().some((entry) => entry.key === trimmed)) {
      throw new CredentialError('That API key is already stored.', 'DUPLICATE_KEY');
    }
    const id = `k_${crypto.randomBytes(4).toString('hex')}`;
    const label = (name && String(name).trim()) || `${providerName(resolved)} key ${this.store.keys.length + 1}`;
    this.store.keys.push({
      id,
      name: label,
      key: trimmed,
      provider: resolved,
      baseUrl: baseUrl ? String(baseUrl).replace(/\/+$/, '') : null,
      model: model ? String(model) : null,
      source: 'stored',
      createdAt: Date.now(),
      lastUsedAt: null,
      status,
      lastError: null,
    });
    if (!this.store.activeId) this.store.activeId = id;
    this.persist();
    return this.list().find((entry) => entry.id === id);
  }

  remove(id) {
    const entry = this.get(id);
    if (!entry) throw new CredentialError('Key not found.', 'NOT_FOUND');
    if (entry.source === 'env') {
      throw new CredentialError(
        `${entry.name} comes from the environment and cannot be removed here. Unset the variable instead.`,
        'ENV_KEY',
      );
    }
    this.store.keys = this.store.keys.filter((item) => item.id !== id);
    if (this.store.activeId === id) {
      this.store.activeId = this.envEntries[0]?.id ?? this.store.keys[0]?.id ?? null;
    }
    this.persist();
    return true;
  }

  rename(id, name) {
    const entry = this.get(id);
    if (!entry) throw new CredentialError('Key not found.', 'NOT_FOUND');
    if (entry.source === 'env') {
      throw new CredentialError(`${entry.name} comes from the environment and cannot be renamed.`, 'ENV_KEY');
    }
    const label = String(name ?? '').trim();
    if (!label) throw new CredentialError('Name cannot be empty.', 'INVALID_NAME');
    entry.name = label.slice(0, 60);
    this.persist();
    return this.list().find((item) => item.id === id);
  }

  setActive(id, { persist = true } = {}) {
    if (!this.get(id)) throw new CredentialError('Key not found.', 'NOT_FOUND');
    this.store.activeId = id;
    // An explicit choice owns the next request; automatic selection resumes after.
    this.preferredId = id;
    if (persist) this.persist();
    return this.activeEntry();
  }

  touch(id) {
    const entry = this.get(id);
    if (!entry) return;
    entry.lastUsedAt = Date.now();
    if (entry.source === 'env') return;
    this.persist();
  }

  setStatus(id, status, lastError = null) {
    const entry = this.get(id);
    if (!entry) return;
    entry.status = ['ready', 'unverified', 'invalid', 'rate_limited', 'blocked'].includes(status) ? status : entry.status;
    entry.lastError = lastError ? String(lastError).slice(0, 300) : null;
    if (entry.source === 'env') return;
    this.persist();
  }

  /**
   * Called when the provider reports an error for the active key. A 401 marks
   * the key invalid; a 403 means the credential authenticated but the account
   * is restricted (TokenHarbor email verification, missing model access), so it
   * is reported as blocked instead of being thrown away. 429 is rate_limited.
   * It never switches keys automatically: the user decides which to rotate to.
   */
  reportFailure(id, httpStatus, detail = null) {
    const suffix = detail ? ` · ${String(detail).slice(0, 240)}` : '';
    if (httpStatus === 401) {
      this.setStatus(id, 'invalid', `HTTP 401${suffix}`);
    } else if (httpStatus === 403) {
      this.setStatus(id, 'blocked', `HTTP 403${suffix}`);
    } else if (httpStatus === 429) {
      this.setStatus(id, 'rate_limited', 'HTTP 429');
    }
  }

  clearFailure(id) {
    this.setStatus(id, 'ready', null);
  }
}

export { CredentialStoreError, validateKeyFormat, maskKey, detectProviderFromKey };
