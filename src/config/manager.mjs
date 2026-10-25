import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureConfigDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from '../util/atomic.mjs';
import { REASONING_DEFAULTS, REASONING_MODES } from '../reasoning/parser.mjs';
import { PASTE_CONTEXT_LIMIT } from '../paste/attachments.mjs';

export const DEFAULT_MODEL = 'z-ai/glm-5.3-flash';
export const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  setupComplete: false,
  workspace: null,
  provider: 'nvidia',
  providers: {
    nvidia: {
      baseUrl: DEFAULT_BASE_URL,
      // Per-model opt-in request parameters. Empty by default: guessing a
      // reasoning parameter can make an otherwise valid request fail.
      reasoningParams: {},
    },
  },
  defaultModel: DEFAULT_MODEL,
  models: [],
  permissions: {
    shell: 'ask', // ask | allow
    fileWrite: 'ask', // ask | allow
    sensitiveRead: 'ask', // ask | allow
  },
  ui: {
    theme: 'dark',
    streaming: true,
    showActivity: true,
    mouse: true,
    reasoning: { ...REASONING_DEFAULTS },
    paste: {
      enabled: true,
      minCharacters: 500,
      minLines: 12,
      maxPreviewLines: 3,
      maxContextCharacters: PASTE_CONTEXT_LIMIT,
      batchDelayMs: 250,
    },
  },
  agent: {
    maxIterations: 20,
    commandTimeoutMs: 30000,
    compactAfterMessages: 80,
  },
  lastSessionId: null,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = deepClone(child);
    return out;
  }
  return value;
}

/**
 * Merge without ever handing out references to `base`: a saved config must not
 * be able to mutate DEFAULT_CONFIG (which would leak between instances/tests).
 */
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch === undefined ? deepClone(base) : deepClone(patch);
  }
  const out = deepClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : deepClone(value);
  }
  return out;
}

export function getPath(object, dotted) {
  return String(dotted)
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), object);
}

export function setPath(object, dotted, value) {
  const parts = String(dotted).split('.').filter(Boolean);
  if (!parts.length) return object;
  let cursor = object;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
  return object;
}

export function mergeWithDefaults(raw) {
  const merged = deepMerge(DEFAULT_CONFIG, isPlainObject(raw) ? raw : {});
  // Guard against invalid enum values in a hand-edited config file.
  const shell = merged.permissions?.shell;
  merged.permissions.shell = shell === 'allow' ? 'allow' : 'ask';
  for (const key of ['fileWrite', 'sensitiveRead']) {
    merged.permissions[key] = merged.permissions[key] === 'allow' ? 'allow' : 'ask';
  }
  merged.agent.maxIterations = clampInt(merged.agent.maxIterations, 1, 60, DEFAULT_CONFIG.agent.maxIterations);
  merged.agent.commandTimeoutMs = clampInt(merged.agent.commandTimeoutMs, 1000, 600000, DEFAULT_CONFIG.agent.commandTimeoutMs);
  merged.agent.compactAfterMessages = clampInt(merged.agent.compactAfterMessages, 20, 2000, 80);
  const paste = merged.ui.paste;
  paste.enabled = paste.enabled !== false;
  paste.minCharacters = clampInt(paste.minCharacters, 0, 1_000_000, 500);
  paste.minLines = clampInt(paste.minLines, 0, 10_000, 12);
  paste.maxPreviewLines = clampInt(paste.maxPreviewLines, 1, 20, 3);
  paste.maxContextCharacters = clampInt(
    paste.maxContextCharacters,
    1000,
    PASTE_CONTEXT_LIMIT,
    PASTE_CONTEXT_LIMIT,
  );
  paste.batchDelayMs = clampInt(paste.batchDelayMs, 40, 2000, 250);
  if (!isPlainObject(merged.ui.reasoning)) merged.ui.reasoning = { ...REASONING_DEFAULTS };
  const reasoning = merged.ui.reasoning;
  reasoning.mode = REASONING_MODES.includes(reasoning.mode) ? reasoning.mode : REASONING_DEFAULTS.mode;
  reasoning.autoCollapseAfterComplete = reasoning.autoCollapseAfterComplete !== false;
  reasoning.showElapsedTime = reasoning.showElapsedTime !== false;
  if (!isPlainObject(merged.providers)) merged.providers = { nvidia: { baseUrl: DEFAULT_BASE_URL } };
  if (!isPlainObject(merged.providers.nvidia)) merged.providers.nvidia = { baseUrl: DEFAULT_BASE_URL };
  if (!isPlainObject(merged.providers.nvidia.reasoningParams)) merged.providers.nvidia.reasoningParams = {};
  if (!Array.isArray(merged.models)) merged.models = [];
  return merged;
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

export class ConfigManager {
  constructor(file = paths.config()) {
    this.file = file;
    this.config = null;
  }

  load() {
    ensureConfigDir();
    let raw = readJson(this.file, null);
    if (raw === null && fs.existsSync(this.file)) {
      // Corrupt JSON: preserve the bad file for inspection instead of silently
      // overwriting the user's settings on the next save.
      try {
        fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      raw = null;
    }
    this.config = mergeWithDefaults(raw ?? {});
    return this.config;
  }

  get() {
    if (!this.config) this.load();
    return this.config;
  }

  save() {
    ensureConfigDir();
    writeJsonAtomic(this.file, this.get(), { mode: 0o600 });
    return this.config;
  }

  update(patch) {
    this.config = deepMerge(this.get(), patch);
    return this.save();
  }

  getValue(dotted) {
    return getPath(this.get(), dotted);
  }

  setValue(dotted, value) {
    setPath(this.config ?? this.load(), dotted, value);
    return this.save();
  }

  reset() {
    this.config = structuredClone(DEFAULT_CONFIG);
    return this.save();
  }

  get baseUrl() {
    const configured = process.env.MIKUHOST_BASE_URL || this.get().providers?.nvidia?.baseUrl || DEFAULT_BASE_URL;
    return String(configured).replace(/\/+$/, '');
  }

  get workspaceSetting() {
    return this.get().workspace || null;
  }

  get permissionMode() {
    return this.get().permissions?.shell === 'allow' ? 'allow' : 'ask';
  }
}

export function loadConfig() {
  return new ConfigManager().load();
}

export { paths, ensureConfigDir, path };
