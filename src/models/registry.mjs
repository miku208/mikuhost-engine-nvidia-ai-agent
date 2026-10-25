import { DEFAULT_MODEL } from '../config/manager.mjs';

/**
 * Built-in model list. Capability metadata is deliberately conservative:
 *   - `streaming: true` is an assumption about the OpenAI-compatible endpoint,
 *     not a per-model guarantee.
 *   - `tools` and `vision` are `null` (unknown) until verified against the
 *     provider catalogue; the agent falls back to a text tool protocol when
 *     native tool calling is not available.
 *   - `contextWindow: null` means unknown. We never invent limits.
 */
export const BUILTIN_MODELS = Object.freeze([
  {
    id: 'z-ai/glm-5.3-flash',
    name: 'GLM 5.3 Flash',
    capabilities: { text: true, streaming: true, tools: null, vision: null, contextWindow: null },
  },
  {
    id: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    name: 'Nemotron 3.5 Super VL',
    capabilities: { text: true, streaming: true, tools: null, vision: null, contextWindow: null },
  },
  {
    id: 'google/diffusiongemma-26b-a4b-it',
    name: 'DiffusionGemma 26B',
    capabilities: { text: true, streaming: true, tools: null, vision: null, contextWindow: null },
  },
  {
    id: 'poolside/laguna-xs-2.1',
    name: 'Laguna XS 2.1',
    capabilities: { text: true, streaming: true, tools: null, vision: null, contextWindow: null },
  },
  {
    id: 'stepfun-ai/step-5-preview',
    name: 'Step 5 Preview',
    capabilities: { text: true, streaming: true, tools: null, vision: null, contextWindow: null },
  },
  {
    // NVIDIA NIM exposes DeepSeek through the same OpenAI-compatible endpoint.
    // Capabilities stay unverified until the live catalogue/model is checked:
    // reasoning and tool support are never assumed from the model name.
    id: 'deepseek-ai/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    provider: 'nvidia',
    baseURL: 'https://integrate.api.nvidia.com/v1',
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

/** Merge builtin + user configured models, tagged with their origin. */
export function buildModelList(userModels = []) {
  const list = BUILTIN_MODELS.map((model) => ({ ...model, source: 'builtin' }));
  const seen = new Set(list.map((model) => model.id));
  for (const entry of Array.isArray(userModels) ? userModels : []) {
    if (!entry) continue;
    const id = typeof entry === 'string' ? entry : entry.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push({
      id,
      name: (typeof entry === 'object' && entry.name) || prettifyModelId(id),
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
  constructor({ userModels = [], defaultModel = DEFAULT_MODEL } = {}) {
    this.userModels = userModels;
    this.defaultModel = defaultModel;
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

  /** Probe availability using a list of model ids returned by GET /v1/models. */
  applyCatalogue(catalogueIds) {
    const ids = new Set(catalogueIds);
    for (const model of this.models) {
      if (ids.has(model.id)) this.markAvailable(model.id);
      else this.markUnavailable(model.id, 'not offered by the current NVIDIA credential');
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
