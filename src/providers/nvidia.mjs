// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import {
  ProviderError,
  ERROR_CODES,
  classifyHttpError,
  classifyFetchError,
  parseRetryAfter,
} from './errors.mjs';
import { reasoningFromEvent, extractReasoning } from '../reasoning/parser.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;

function joinUrl(baseUrl, endpoint) {
  return `${String(baseUrl).replace(/\/+$/, '')}${endpoint}`;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .filter(Boolean)
      .join('');
  }
  return '';
}

function normalizeToolCalls(rawCalls) {
  if (!Array.isArray(rawCalls)) return [];
  return rawCalls
    .filter((call) => call && call.function)
    .map((call, index) => ({
      id: call.id || `call_${Date.now()}_${index}`,
      type: 'function',
      function: {
        name: String(call.function.name ?? ''),
        arguments:
          typeof call.function.arguments === 'string'
            ? call.function.arguments
            : JSON.stringify(call.function.arguments ?? {}),
      },
    }));
}

/** Merge incremental streaming tool_call deltas keyed by index. */
function mergeToolCallDelta(acc, delta) {
  if (!Array.isArray(delta)) return;
  for (const part of delta) {
    const index = Number.isInteger(part?.index) ? part.index : acc.length;
    if (!acc[index]) acc[index] = { id: null, type: 'function', function: { name: '', arguments: '' } };
    const target = acc[index];
    if (part.id) target.id = part.id;
    if (part.type) target.type = part.type;
    if (part.function?.name) target.function.name = part.function.name;
    if (part.function?.arguments) target.function.arguments += part.function.arguments;
  }
}

async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLines = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (!dataLines.length) continue;
      const payload = dataLines.join('\n');
      if (payload === '[DONE]') return;
      try {
        yield JSON.parse(payload);
      } catch {
        // Ignore malformed keep-alive/partial frames rather than crashing the stream.
      }
    }
  }
}

export class NvidiaProvider {
  constructor({ baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch, maxAttempts = 2 } = {}) {
    if (!baseUrl) throw new ProviderError('API base URL is not configured for this provider.', { code: ERROR_CODES.BAD_REQUEST });
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.apiKey = apiKey ?? null;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.maxAttempts = Math.max(1, Math.min(3, maxAttempts));
  }

  headers(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'mikuhost-agent/1.0',
      ...extra,
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  abortSignal(callerSignal, timeoutMs = this.timeoutMs) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (!callerSignal) return { signal: timeoutSignal, isTimeout: () => timeoutSignal.aborted };
    const combined = AbortSignal.any([callerSignal, timeoutSignal]);
    return { signal: combined, isTimeout: () => timeoutSignal.aborted && !callerSignal.aborted };
  }

  async request(endpoint, { method = 'GET', body, signal: callerSignal, timeoutMs } = {}) {
    const { signal, isTimeout } = this.abortSignal(callerSignal, timeoutMs);
    try {
      const response = await this.fetchImpl(joinUrl(this.baseUrl, endpoint), {
        method,
        headers: this.headers(body ? { Accept: 'text/event-stream' } : {}),
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      return { response, isTimeout };
    } catch (error) {
      throw classifyFetchError(error, { timedOut: isTimeout() });
    }
  }

  /** GET /models. Returns model ids offered to the current key. */
  async listModels({ signal } = {}) {
    const { response, isTimeout } = await this.request('/models', { signal, timeoutMs: 20_000 });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw classifyHttpError(response.status, text, response.headers);
    }
    let json;
    try {
      json = await response.json();
    } catch (error) {
      throw new ProviderError('Malformed model catalogue response.', {
        code: ERROR_CODES.MALFORMED,
        detail: isTimeout() ? 'timeout' : String(error?.message ?? error),
      });
    }
    const data = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    return data.map((entry) => (typeof entry === 'string' ? entry : entry?.id)).filter(Boolean);
  }

  /**
   * Real completion used to verify a credential, exactly like the manual curl:
   * POST /chat/completions with `Authorization: Bearer <key>`. A catalogue call
   * is not proof of a working key: some gateways list models without checking
   * the credential, and a key can be accepted by /models but rejected for chat.
   *
   * A 429 waits for Retry-After (capped) and tries again, because free tiers
   * rate-limit quickly. The key never appears in the returned value.
   */
  async probeChat({ key = this.apiKey, model, signal = null, timeoutMs = 30_000, attempts = 2, onWait = null } = {}) {
    const probe = new NvidiaProvider({
      baseUrl: this.baseUrl,
      apiKey: key,
      fetchImpl: this.fetchImpl,
      timeoutMs,
    });
    const body = {
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      temperature: 0,
      stream: false,
    };
    const tries = Math.max(1, Math.min(3, attempts));
    let lastError = null;

    for (let attempt = 1; attempt <= tries; attempt += 1) {
      let response;
      try {
        ({ response } = await probe.request('/chat/completions', {
          method: 'POST',
          body,
          signal,
          timeoutMs,
        }));
      } catch (error) {
        if (error.code === ERROR_CODES.NETWORK) return { valid: false, offline: true, error };
        return { valid: false, offline: false, inconclusive: true, error };
      }

      if (response.ok) {
        // Drain the body so the socket is reusable; the answer itself is not used.
        await response.text().catch(() => '');
        return { valid: true, offline: false, model, attempts: attempt };
      }

      const error = await probe.readErrorResponse(response);
      lastError = error;
      if (error.code === ERROR_CODES.INVALID_MODEL) {
        // The credential authenticated; only the model id is wrong.
        return {
          valid: true,
          offline: false,
          model,
          warning: `${model} is not available for this key.`,
          error,
        };
      }
      if (error.code === ERROR_CODES.RATE_LIMIT) {
        if (attempt < tries && !signal?.aborted) {
          const waitMs = Math.min(error.retryAfterMs ?? 2000 * attempt, 15_000);
          onWait?.({ waitMs, attempt, next: attempt + 1 });
          try {
            await delay(waitMs, signal);
          } catch {
            /* cancelled while waiting */
          }
          if (signal?.aborted) return { valid: false, offline: false, inconclusive: true, error };
          continue;
        }
        return {
          valid: false,
          offline: false,
          rateLimited: true,
          retryAfterMs: error.retryAfterMs ?? null,
          error,
        };
      }
      if (error.code === ERROR_CODES.ACCOUNT) {
        // 403 + a provider account code: the key authenticated, the account is
        // what needs action (e.g. TokenHarbor email verification).
        return { valid: false, offline: false, blocked: true, accountBlocked: true, error };
      }
      if (error.code === ERROR_CODES.AUTH) {
        return { valid: false, offline: false, error };
      }
      if (error.code === ERROR_CODES.FORBIDDEN) {
        // Authenticated but not allowed: do not call the key invalid either.
        return { valid: false, offline: false, blocked: true, error };
      }
      return { valid: false, offline: false, inconclusive: true, error };
    }

    return { valid: false, offline: false, inconclusive: true, error: lastError };
  }

  /**
   * Validate a key without leaking it. With a model, this performs the real
   * chat request and also reports the catalogue size; without one (a provider
   * with no configured model) it falls back to GET /models.
   *
   * Returns a structured result instead of throwing so the setup wizard can
   * offer Retry / Replace / Exit.
   */
  async validateKey(key, { signal, model = null, timeoutMs = 30_000, attempts = 2, onWait = null } = {}) {
    const probe = new NvidiaProvider({
      baseUrl: this.baseUrl,
      apiKey: key,
      fetchImpl: this.fetchImpl,
      timeoutMs,
    });

    if (model) {
      const result = await probe.probeChat({ key, model, signal, timeoutMs, attempts, onWait });
      if (!result.valid) return result;
      // The chat request is the proof; the catalogue only adds the model count.
      const models = await probe.listModels({ signal }).catch(() => null);
      return { ...result, models: Array.isArray(models) ? models : [] };
    }

    try {
      const models = await probe.listModels({ signal });
      return { valid: true, offline: false, models };
    } catch (error) {
      if (error.code === ERROR_CODES.NETWORK) {
        return { valid: false, offline: true, error };
      }
      if (error.code === ERROR_CODES.ACCOUNT) {
        return { valid: false, offline: false, blocked: true, accountBlocked: true, error };
      }
      if (error.code === ERROR_CODES.AUTH) {
        return { valid: false, offline: false, error };
      }
      if (error.code === ERROR_CODES.FORBIDDEN) {
        return { valid: false, offline: false, blocked: true, error };
      }
      // Reachable but e.g. 5xx: do not claim the key is valid, do not claim it
      // is invalid either.
      return { valid: false, offline: false, inconclusive: true, error };
    }
  }

  buildChatBody({ model, messages, tools, toolChoice = 'auto', temperature = 0.6, maxTokens, stream = true, extraBody = null }) {
    const body = {
      model,
      messages,
      stream,
      temperature,
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = Math.round(maxTokens);
    if (Array.isArray(tools) && tools.length) {
      body.tools = tools;
      body.tool_choice = toolChoice;
    }
    // Per-model reasoning knobs are opt-in (see providers.nvidia.reasoningParams).
    // We never guess a parameter: an unsupported one would fail the request.
    if (extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody)) {
      for (const [key, value] of Object.entries(extraBody)) {
        if (value === undefined) continue;
        if (['model', 'messages', 'stream', 'tools', 'tool_choice'].includes(key)) continue;
        body[key] = value;
      }
    }
    return body;
  }

  async readErrorResponse(response) {
    const text = await response.text().catch(() => '');
    return classifyHttpError(response.status, text, response.headers);
  }

  /**
   * Stream a chat completion. Yields events:
   *   { type: 'reasoning', text }   (only when the provider sent reasoning)
   *   { type: 'text', text }        (the final answer; never reasoning)
   *   { type: 'tool_calls', toolCalls }
   *   { type: 'usage', usage }
   *   { type: 'done', finishReason, toolCalls, usage, model }
   *
   * Falls back to a single non-streaming request if the model rejects streaming.
   */
  async *streamChat({ model, messages, tools, toolChoice, temperature, maxTokens, signal, onRequest, extraBody = null } = {}) {
    let attempt = 0;
    let fallbackUsed = false;

    while (attempt < this.maxAttempts) {
      attempt += 1;
      const body = this.buildChatBody({
        model,
        messages,
        tools,
        toolChoice,
        temperature,
        maxTokens,
        stream: true,
        extraBody,
      });
      onRequest?.({ attempt, body });
      let response;
      let isTimeout = () => false;
      try {
        ({ response, isTimeout } = await this.request('/chat/completions', { method: 'POST', body, signal }));
      } catch (error) {
        if (error.retriable && attempt < this.maxAttempts) {
          await delay(400 * attempt, signal);
          continue;
        }
        throw error;
      }

      if (!response.ok) {
        const error = await this.readErrorResponse(response);
        if (
          !fallbackUsed &&
          response.status === 400 &&
          /stream/i.test(error.detail ?? error.message ?? '')
        ) {
          fallbackUsed = true;
          yield* this.nonStreamingFallback({
            model,
            messages,
            tools,
            toolChoice,
            temperature,
            maxTokens,
            signal,
            onRequest,
            extraBody,
          });
          return;
        }
        if (error.retriable && attempt < this.maxAttempts && !signal?.aborted) {
          const wait = error.retryAfterMs ?? 400 * attempt;
          await delay(Math.min(wait, 5000), signal);
          continue;
        }
        throw error;
      }

      const toolCallAcc = [];
      let finishReason = null;
      let usage = null;
      let emitted = false;

      try {
        for await (const event of parseSSE(response.body)) {
          if (event?.usage) usage = normaliseUsage(event.usage);
          const choice = event?.choices?.[0];
          if (choice?.delta?.tool_calls) mergeToolCallDelta(toolCallAcc, choice.delta.tool_calls);
          // Reasoning is only emitted when an explicit reasoning field is
          // present. Absent fields, empty chunks and malformed values are
          // ignored; answer text is never reclassified as reasoning.
          const reasoning = reasoningFromEvent(event);
          if (reasoning) {
            emitted = true;
            yield { type: 'reasoning', text: reasoning };
          }
          const text = contentToText(choice?.delta?.content);
          if (text) {
            emitted = true;
            yield { type: 'text', text };
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
        }
      } catch (error) {
        if (signal?.aborted) {
          throw new ProviderError('Request cancelled.', { code: ERROR_CODES.ABORTED });
        }
        if (isTimeout()) {
          throw new ProviderError('Stream timed out.', { code: ERROR_CODES.TIMEOUT });
        }
        if (!emitted && attempt < this.maxAttempts) {
          await delay(400 * attempt, signal).catch(() => {});
          continue;
        }
        throw new ProviderError(`Stream interrupted: ${error?.message ?? error}`, {
          code: ERROR_CODES.NETWORK,
          retriable: !emitted,
        });
      }

      const toolCalls = normalizeToolCalls(toolCallAcc);
      if (usage) yield { type: 'usage', usage };
      if (toolCalls.length) yield { type: 'tool_calls', toolCalls };
      yield { type: 'done', finishReason, toolCalls, usage, model };
      return;
    }

    throw new ProviderError('Request failed after retries.', { code: ERROR_CODES.UNKNOWN });
  }

  async *nonStreamingFallback({ model, messages, tools, toolChoice, temperature, maxTokens, signal, onRequest, extraBody = null } = {}) {
    onRequest?.({ attempt: 1, fallback: true });
    const body = this.buildChatBody({
      model,
      messages,
      tools,
      toolChoice,
      temperature,
      maxTokens,
      stream: false,
      extraBody,
    });
    const { response } = await this.request('/chat/completions', { method: 'POST', body, signal });
    if (!response.ok) throw await this.readErrorResponse(response);
    // Tell the loop this answer arrives in one piece so the UI keeps saying
    // "Thinking" instead of claiming a stream that does not exist.
    yield { type: 'transport', streaming: false };

    let json;
    try {
      json = await response.json();
    } catch {
      throw new ProviderError('Malformed response from the model.', { code: ERROR_CODES.MALFORMED });
    }
    const choice = json?.choices?.[0];
    const reasoning = extractReasoning(choice?.message) || extractReasoning(json);
    if (reasoning) yield { type: 'reasoning', text: reasoning };
    const text = contentToText(choice?.message?.content);
    if (text) yield { type: 'text', text };
    const toolCalls = normalizeToolCalls(choice?.message?.tool_calls);
    const usage = normaliseUsage(json?.usage);
    if (usage) yield { type: 'usage', usage };
    if (toolCalls.length) yield { type: 'tool_calls', toolCalls };
    yield { type: 'done', finishReason: choice?.finish_reason ?? 'stop', toolCalls, usage, model, fallback: true };
  }

  /** Non-streaming convenience call (used by tests and by chat-only mode). */
  async chat({ model, messages, tools, toolChoice, temperature, maxTokens, signal, extraBody } = {}) {
    let text = '';
    let toolCalls = [];
    let usage = null;
    let finishReason = null;
    for await (const event of this.streamChat({ model, messages, tools, toolChoice, temperature, maxTokens, signal, extraBody })) {
      if (event.type === 'text') text += event.text;
      if (event.type === 'tool_calls') toolCalls = event.toolCalls;
      if (event.type === 'usage') usage = event.usage;
      if (event.type === 'done') {
        finishReason = event.finishReason;
        if (event.toolCalls?.length) toolCalls = event.toolCalls;
      }
    }
    return { text, toolCalls, usage, finishReason };
  }
}

function normaliseUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const total = Number(usage.total_tokens ?? prompt + completion) || prompt + completion;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError('Request cancelled.', { code: ERROR_CODES.ABORTED }));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new ProviderError('Request cancelled.', { code: ERROR_CODES.ABORTED }));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export { normalizeToolCalls, parseRetryAfter };
