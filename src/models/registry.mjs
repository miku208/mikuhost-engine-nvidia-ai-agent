// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import { DEFAULT_MODEL } from '../config/manager.mjs';
import { resolveProviderId, getProvider, providerModelFromEnv } from '../providers/catalog.mjs';

/**
 * Built-in model list. Capability metadata is deliberately conservative:
 *   - `streaming: true` is an assumption about the OpenAI-compatible endpoint,
 *     not a per-model guarantee.
 *   - `tools` and `vision` are `null` (unknown) until verified against the
 *     provider catalogue; the agent falls back to a text tool protocol when
 *     native tool calling is not available.
 *   - `contextWindow: null` means unknown. We never invent limits.
 *
 * Every model is tagged with the provider that serves it: switching to a
 * TokenHarbor key must not keep requesting an NVIDIA-only model id.
 */
export const BUILTIN_MODELS = Object.freeze([
  {
    id: 'z-ai/glm-5.3-flash',
    name: 'GLM 5.3 Flash',
    provider: 'nvidia',
    capabilities: { text: true, streaming: true, tools: null, vision: null, contextWindow: null },
  },
  {
    id: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    name: 'Nemotron 3.5 Super VL',
    provider: 'nvidia',
    capabilities: { text: true, streaming: true, tools: null, vision: null, contextWindow: null },
  },
  {
    id: 'google/diffusiongemma-26b-a4b-it',
    name: 'DiffusionGemma 26B',
    provider: 'nvidia',
    capabilities: { text: true, streaming: true, tools: null, vision: null, contextWindow: null },
  },
  {
    id: 'poolside/laguna-xs-2.1',
    name: 'Laguna XS 2.1',
    provider: 'nvidia',
    capabilities: { text: true, streaming: true, tools: null, vision: null, contextWindow: null },
  },
  {
    id: 'stepfun-ai/step-5-preview',
    name: 'Step 5 Preview',
    provider: 'nvidia',
    capabilities: { text: true, streaming: true, tools: null, vision: null, contextWindow: null },
  },
  {
    // DeepSeek is served by Token Harbor only: NVIDIA picks up a DeepSeek model
    // from its live catalogue if it offers one, so a built-in NVIDIA DeepSeek
    // entry would only invite requests for an id the provider does not serve.
    // Token Harbor's free tier id, exactly as listed in its catalogue.
    id: 'deepseek-v4.1-flash:free',
    name: 'DeepSeek V4.1 Flash (free)',
    provider: 'tokenharbor',
    capabilities: { text: true, streaming: true, tools: null, vision: null, contextWindow: null },
  },
]);

export class ModelError extends Error {
  constructor(message, code = 'MODEL') {
    super(message);
    this.name = 'ModelError';
    this.code = code;
  }
}

export function prettifyModelId(id) {
  const tail = String(id ?? '').split('/').pop() ?? String(id ?? '');
  return tail
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => {
      if (/^\d+$/.test(part)) return part;
      if (/^[a-z]\d+$/i.test(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

/** Merge builtin + user configured models, tagged with provider and origin. */
export function buildModelList(userModels = []) {
  const list = BUILTIN_MODELS.map((model) => ({
    ...model,
    provider: resolveProviderId(model.provider),
    source: 'builtin',
  }));
  const seen = new Set(list.map((model) => model.id));
  for (const entry of Array.isArray(userModels) ? userModels : []) {
    if (!entry) continue;
    const id = typeof entry === 'string' ? entry : entry.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push({
      id,
      name: (typeof entry === 'object' && entry.name) || prettifyModelId(id),
      provider: resolveProviderId(typeof entry === 'object' ? entry.provider : null),
      baseURL: typeof entry === 'object' && entry.baseURL ? entry.baseURL : undefined,
      capabilities: {
        text: true,
        streaming: true,
        tools: null,
        vision: null,
        contextWindow: null,
        ...(typeof entry === 'object' && entry.capabilities ? entry.capabilities : {}),
      },
      source: 'config',
    });
  }
  return list;
}

export class ModelRegistry {
  constructor({ userModels = [], defaultModel = DEFAULT_MODEL, env = process.env } = {}) {
    this.userModels = userModels;
    this.defaultModel = defaultModel;
    this.env = env;
    this.models = buildModelList(userModels);
    /** @type {Map<string, {status: 'unknown'|'available'|'unavailable', reason: string|null, checkedAt: number|null}>} */
    this.availability = new Map();
  }

  list() {
    return this.models.map((model) => ({ ...model, availability: this.status(model.id) }));
  }

  ids() {
    return this.models.map((model) => model.id);
  }

  /** Models served by one provider, in catalogue order. */
  forProvider(providerId) {
    const id = resolveProviderId(providerId);
    return this.models.filter((model) => resolveProviderId(model.provider) === id);
  }

  /**
   * Default model for a provider: environment override (TOKENHARBOR_MODEL),
   * then the first model listed for that provider. Returns null when the
   * provider has no known model, so the caller can ask for one instead of
   * silently sending an unusable id.
   */
  defaultFor(providerId) {
    const id = resolveProviderId(providerId);
    const fromEnv = providerModelFromEnv(id, this.env);
    if (fromEnv) {
      return this.byId(fromEnv) ?? { id: fromEnv, name: prettifyModelId(fromEnv), provider: id, capabilities: { text: true, streaming: true, tools: null, vision: null, contextWindow: null }, source: 'env' };
    }
    const configured = getProvider(id)?.defaultModel;
    const listed = this.forProvider(id);
    return listed.find((model) => model.id === configured) ?? listed[0] ?? null;
  }

  has(id) {
    return this.models.some((model) => model.id === id);
  }

  byId(id) {
    return this.models.find((model) => model.id === id) ?? null;
  }

  /** 1-based index, matching the model panel numbering. */
  byIndex(index) {
    const num = Number(index);
    if (!Number.isInteger(num) || num < 1 || num > this.models.length) return null;
    return this.models[num - 1];
  }

  displayName(id) {
    if (!id) return 'No model';
    return this.byId(id)?.name ?? prettifyModelId(id);
  }

  /**
   * Resolve user input: 1-based index, exact id, unique case-insensitive
   * substring of id or name.
   */
  resolve(input) {
    const raw = String(input ?? '').trim();
    if (!raw) throw new ModelError('Model id is required.', 'EMPTY');
    const byIndex = this.byIndex(raw);
    if (byIndex) return byIndex;

    const exact = this.models.find((model) => model.id === raw);
    if (exact) return exact;
    const exactName = this.models.find((model) => model.name.toLowerCase() === raw.toLowerCase());
    if (exactName) return exactName;

    const needle = raw.toLowerCase();
    const matches = this.models.filter(
      (model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new ModelError(
        `Model name "${raw}" is ambiguous (${matches.map((m) => m.id).join(', ')}).`,
        'AMBIGUOUS',
      );
    }
    throw new ModelError(`Unknown model: ${raw}`, 'NOT_FOUND');
  }

  status(id) {
    return this.availability.get(id) ?? { status: 'unknown', reason: null, checkedAt: null };
  }

  markAvailable(id) {
    this.availability.set(id, { status: 'available', reason: null, checkedAt: Date.now() });
  }

  markUnavailable(id, reason = 'not present in the provider catalogue') {
    this.availability.set(id, { status: 'unavailable', reason, checkedAt: Date.now() });
  }

  /**
   * Probe availability using a list of model ids returned by GET /v1/models.
   * With `provider`, only that provider's models are re-marked: a TokenHarbor
   * catalogue says nothing about NVIDIA availability (and vice versa).
   */
  applyCatalogue(catalogueIds, { provider = null } = {}) {
    const ids = new Set(catalogueIds);
    const scope = provider ? resolveProviderId(provider) : null;
    const label = scope ? getProvider(scope)?.name ?? scope : 'the current credential';
    for (const model of this.models) {
      if (scope && resolveProviderId(model.provider) !== scope) continue;
      if (ids.has(model.id)) this.markAvailable(model.id);
      else this.markUnavailable(model.id, `not offered by ${label}`);
    }
    return this;
  }

  /** Models present in the provider catalogue but not in the registry. */
  extraCatalogueModels(catalogueIds) {
    const known = new Set(this.ids());
    return Array.from(catalogueIds).filter((id) => !known.has(id));
  }

  get defaultEntry() {
    return this.byId(this.defaultModel) ?? this.models[0] ?? null;
  }
}
