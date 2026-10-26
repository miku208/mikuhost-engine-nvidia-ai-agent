// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import { NvidiaProvider } from './nvidia.mjs';

/**
 * Provider catalogue.
 *
 * Every entry speaks the OpenAI-compatible chat-completions API, so one
 * transport class (NvidiaProvider) serves all of them. What differs is the
 * base URL, which environment variables carry the credential, and the model
 * ids that exist there.
 *
 * `envKeys` is also the auto-detection source: a token found in one of those
 * variables is imported automatically on startup, without touching
 * credentials.json and without ever being printed.
 */
export const DEFAULT_PROVIDER = 'nvidia';
export const GLOBAL_BASE_URL_ENV = 'MIKUHOST_BASE_URL';

export const PROVIDERS = Object.freeze({
  nvidia: Object.freeze({
    id: 'nvidia',
    name: 'NVIDIA',
    description: 'NVIDIA NIM (integrate.api.nvidia.com)',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    envKeys: ['NVIDIA_API_KEY'],
    envBaseUrl: ['NVIDIA_BASE_URL'],
    envModel: ['NVIDIA_MODEL'],
    keyPrefixes: ['nvapi-'],
    defaultModel: 'z-ai/glm-5.3-flash',
    docsUrl: 'https://build.nvidia.com',
  }),
  tokenharbor: Object.freeze({
    id: 'tokenharbor',
    name: 'TokenHarbor',
    description: 'Token Harbor gateway (tokenharbor.ai), OpenAI-compatible',
    baseUrl: 'https://tokenharbor.ai/v1',
    envKeys: ['TOKENHARBOR_API_KEY'],
    envBaseUrl: ['TOKENHARBOR_BASE_URL'],
    envModel: ['TOKENHARBOR_MODEL'],
    keyPrefixes: ['thk_', 'thk-', 'th-'],
    defaultModel: 'deepseek-v4.1-flash:free',
    docsUrl: 'https://tokenharbor.ai/docs',
  }),
  custom: Object.freeze({
    id: 'custom',
    name: 'Custom',
    description: 'Any OpenAI-compatible endpoint (set MIKUHOST_API_KEY and MIKUHOST_BASE_URL)',
    baseUrl: null,
    envKeys: ['MIKUHOST_API_KEY'],
    envBaseUrl: [GLOBAL_BASE_URL_ENV],
    envModel: ['MIKUHOST_MODEL'],
    keyPrefixes: [],
    defaultModel: null,
    docsUrl: null,
  }),
});

export function providerList() {
  return Object.values(PROVIDERS);
}

export function providerIds() {
  return providerList().map((provider) => provider.id);
}

export function getProvider(id) {
  const key = String(id ?? '')
    .trim()
    .toLowerCase();
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(PROVIDERS, key) ? PROVIDERS[key] : null;
}

export function resolveProviderId(id) {
  return getProvider(id)?.id ?? DEFAULT_PROVIDER;
}

export function providerName(id, fallback = 'Provider') {
  return getProvider(id)?.name ?? fallback;
}

/** First non-empty value among `names`; environment values are trimmed. */
export function envValue(env, names) {
  for (const name of Array.isArray(names) ? names : [names]) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Provider implied by a token prefix. Returns null when the prefix is not
 * recognisable, so the caller keeps the configured/active provider instead of
 * guessing.
 */
export function detectProviderFromKey(key) {
  const value = String(key ?? '').trim().toLowerCase();
  if (!value) return null;
  for (const provider of providerList()) {
    if (provider.keyPrefixes.some((prefix) => value.startsWith(prefix))) return provider.id;
  }
  return null;
}

/** Provider-specific base URL from the environment, if any. */
export function providerBaseUrlFromEnv(providerId, env = process.env) {
  const provider = getProvider(providerId);
  if (!provider) return envValue(env, GLOBAL_BASE_URL_ENV);
  return envValue(env, provider.envBaseUrl) ?? envValue(env, GLOBAL_BASE_URL_ENV);
}

/** Model override from the environment, if any (e.g. TOKENHARBOR_MODEL). */
export function providerModelFromEnv(providerId, env = process.env) {
  const provider = getProvider(providerId);
  return provider ? envValue(env, provider.envModel) : null;
}

/**
 * Every credential supplied through the environment, in catalogue order.
 * Values never leave this module through the UI; only the provider id and a
 * masked key are rendered.
 */
export function credentialsFromEnv(env = process.env) {
  const found = [];
  for (const provider of providerList()) {
    const key = envValue(env, provider.envKeys);
    if (!key) continue;
    const baseUrl = providerBaseUrlFromEnv(provider.id, env);
    // A custom gateway without a base URL has nowhere to send the request.
    if (provider.id === 'custom' && !baseUrl) continue;
    const model = providerModelFromEnv(provider.id, env);
    found.push({ provider: provider.id, key, baseUrl: baseUrl ?? null, model: model ?? null });
  }
  return found;
}

/** The provider whose token was found first in the environment, if any. */
export function detectedEnvProvider(env = process.env) {
  return credentialsFromEnv(env)[0]?.provider ?? null;
}

/**
 * Build the transport for a provider. `baseUrl` wins when given (an env key
 * stored with the credential), otherwise the provider-specific env override,
 * then the catalogue default.
 */
export function createProvider({ provider = DEFAULT_PROVIDER, baseUrl = null, apiKey = null, env = process.env, ...rest } = {}) {
  const id = resolveProviderId(provider);
  const resolved =
    String(baseUrl ?? '').trim() ||
    providerBaseUrlFromEnv(id, env) ||
    getProvider(id)?.baseUrl ||
    null;
  return new NvidiaProvider({ baseUrl: resolved, apiKey, ...rest });
}

/** Human-readable list of env variables that can supply a token. */
export function envKeyNames() {
  return providerList().flatMap((provider) => provider.envKeys.map((name) => `${name} (${provider.name})`));
}
