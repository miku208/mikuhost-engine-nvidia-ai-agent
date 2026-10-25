import crypto from 'node:crypto';
import { paths } from '../config/paths.mjs';
import { maskKey } from '../util/text.mjs';
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

/**
 * Manages multiple NVIDIA API keys. Plaintext key material only ever leaves
 * this module through `activeKey()` (to the provider) and `reveal()` (used by
 * the validation step). Everything the UI sees is masked.
 */
export class CredentialManager {
  constructor({ file = paths.credentials(), store = null } = {}) {
    this.file = file;
    this.store = store ?? loadCredentialStore(file);
  }

  reload() {
    this.store = loadCredentialStore(this.file);
    return this;
  }

  persist() {
    this.store = saveCredentialStore(this.store, this.file);
    return this;
  }

  list() {
    return this.store.keys.map((entry) => ({
      id: entry.id,
      name: entry.name,
      masked: maskKey(entry.key),
      active: entry.id === this.store.activeId,
      status: entry.status,
      lastUsedAt: entry.lastUsedAt,
      lastError: entry.lastError,
      createdAt: entry.createdAt,
    }));
  }

  get size() {
    return this.store.keys.length;
  }

  get activeId() {
    return this.store.activeId;
  }

  get(id) {
    return this.store.keys.find((entry) => entry.id === id) ?? null;
  }

  activeEntry() {
    return this.get(this.store.activeId) ?? null;
  }

  activeKey() {
    return this.activeEntry()?.key ?? null;
  }

  /** Only used right before sending a request; never rendered. */
  reveal(id) {
    return this.get(id)?.key ?? null;
  }

  findByKey(key) {
    const value = String(key ?? '').trim();
    return this.store.keys.find((entry) => entry.key === value) ?? null;
  }

  add({ name, key, status = 'unverified' } = {}) {
    const check = validateKeyFormat(key);
    if (!check.ok) throw new CredentialError(check.reason, 'INVALID_KEY_FORMAT');
    const trimmed = String(key).trim();
    if (this.store.keys.some((entry) => entry.key === trimmed)) {
      throw new CredentialError('That API key is already stored.', 'DUPLICATE_KEY');
    }
    const id = `k_${crypto.randomBytes(4).toString('hex')}`;
    const label = (name && String(name).trim()) || `Key ${this.store.keys.length + 1}`;
    this.store.keys.push({
      id,
      name: label,
      key: trimmed,
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
    this.store.keys = this.store.keys.filter((item) => item.id !== id);
    if (this.store.activeId === id) this.store.activeId = this.store.keys[0]?.id ?? null;
    this.persist();
    return true;
  }

  rename(id, name) {
    const entry = this.get(id);
    if (!entry) throw new CredentialError('Key not found.', 'NOT_FOUND');
    const label = String(name ?? '').trim();
    if (!label) throw new CredentialError('Name cannot be empty.', 'INVALID_NAME');
    entry.name = label.slice(0, 60);
    this.persist();
    return this.list().find((item) => item.id === id);
  }

  setActive(id) {
    if (!this.get(id)) throw new CredentialError('Key not found.', 'NOT_FOUND');
    this.store.activeId = id;
    this.persist();
    return this.activeEntry();
  }

  touch(id) {
    const entry = this.get(id);
    if (!entry) return;
    entry.lastUsedAt = Date.now();
    this.persist();
  }

  setStatus(id, status, lastError = null) {
    const entry = this.get(id);
    if (!entry) return;
    entry.status = ['ready', 'unverified', 'invalid', 'rate_limited'].includes(status) ? status : entry.status;
    entry.lastError = lastError ? String(lastError).slice(0, 300) : null;
    this.persist();
  }

  /**
   * Called when the provider reports an error for the active key. Marks the
   * key invalid on auth failures and rate_limited on 429. It never switches
   * keys automatically: the user decides which credential to rotate to.
   */
  reportFailure(id, httpStatus) {
    if (httpStatus === 401 || httpStatus === 403) {
      this.setStatus(id, 'invalid', `HTTP ${httpStatus}`);
    } else if (httpStatus === 429) {
      this.setStatus(id, 'rate_limited', 'HTTP 429');
    }
  }

  clearFailure(id) {
    this.setStatus(id, 'ready', null);
  }
}

export { CredentialStoreError, validateKeyFormat, maskKey };
