/**
 * Provider reasoning adapter.
 *
 * NVIDIA NIM exposes reasoning for supported models in
 * `choices[].delta.reasoning_content` while the final answer stays in
 * `choices[].delta.content`. Other OpenAI-compatible gateways use `reasoning`
 * or `reasoning_details`. We only read what the provider actually sent; no
 * reasoning is ever inferred from normal answer text.
 *
 * Fields are treated as incremental deltas, which is how OpenAI-compatible
 * streaming endpoints deliver them.
 */

export const REASONING_MODES = Object.freeze(['auto', 'on', 'off']);

export const REASONING_DEFAULTS = Object.freeze({
  mode: 'auto',
  autoCollapseAfterComplete: true,
  showElapsedTime: true,
});

export function reasoningSettings(source = {}) {
  const raw = source?.ui?.reasoning ?? source?.reasoning ?? source ?? {};
  const mode = REASONING_MODES.includes(raw?.mode) ? raw.mode : REASONING_DEFAULTS.mode;
  return {
    mode,
    enabled: mode !== 'off',
    autoCollapseAfterComplete: raw?.autoCollapseAfterComplete !== false,
    showElapsedTime: raw?.showElapsedTime !== false,
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length) return value;
  }
  return '';
}

/**
 * Turn a reasoning field into text. Accepts the shapes seen in the wild:
 *   "text"
 *   { text } / { content } / { summary } / { reasoning }
 *   [{ type: 'reasoning.text', text }, ...]
 */
export function reasoningText(value, depth = 0) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (depth > 4) return '';
  if (Array.isArray(value)) {
    return value.map((entry) => reasoningText(entry, depth + 1)).join('');
  }
  if (typeof value !== 'object') return '';
  // summary/content can themselves be arrays (e.g. summary_text blocks).
  for (const key of ['text', 'content', 'summary', 'reasoning_content', 'reasoning', 'thinking']) {
    if (value[key] === undefined) continue;
    const text = reasoningText(value[key], depth + 1);
    if (text) return text;
  }
  if (value.delta !== undefined) return reasoningText(value.delta, depth + 1);
  return '';
}

/** Extract explicit reasoning from a delta/message-like object. */
export function extractReasoning(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return '';

  const content = firstString(payload.reasoning_content);
  if (content) return content;

  const reasoning = payload.reasoning;
  if (typeof reasoning === 'string' && reasoning.length) return reasoning;
  if (reasoning && typeof reasoning === 'object') {
    const text = reasoningText(reasoning);
    if (text) return text;
  }

  for (const key of ['reasoning_details', 'reasoning_content_details', 'thinking']) {
    if (payload[key] === undefined) continue;
    const text = reasoningText(payload[key]);
    if (text) return text;
  }

  // Provider-specific reasoning events (e.g. { type: 'reasoning', delta: ... }).
  if (typeof payload.type === 'string' && /reason/i.test(payload.type)) {
    const text = reasoningText(payload.delta ?? payload.text ?? payload.content ?? payload.reasoning);
    if (text) return text;
  }
  return '';
}

/** Reasoning carried by one streamed choice, checking delta then message. */
export function reasoningFromChoice(choice) {
  if (!choice || typeof choice !== 'object') return '';
  return extractReasoning(choice.delta) || extractReasoning(choice.message) || extractReasoning(choice);
}

/** Reasoning carried by one SSE event. Choice-level fields win. */
export function reasoningFromEvent(event) {
  if (!event || typeof event !== 'object') return '';
  const choice = Array.isArray(event.choices) ? event.choices[0] : null;
  return reasoningFromChoice(choice) || extractReasoning(event);
}
