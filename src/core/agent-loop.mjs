import { ProviderError, ERROR_CODES } from '../providers/errors.mjs';
import { PHASES, EVENTS } from './events.mjs';

const TOOL_TIMEOUT_MS = 120_000;

/** Hides <tool_call> protocol blocks from streamed output in fallback mode. */
export class ToolProtocolFilter {
  constructor() {
    this.buffer = '';
    this.inside = false;
    this.open = '<tool_call>';
    this.close = '</tool_call>';
  }

  feed(chunk) {
    this.buffer += chunk;
    let output = '';
    for (let guard = 0; guard < 100; guard += 1) {
      if (!this.inside) {
        const start = this.buffer.indexOf(this.open);
        if (start === -1) {
          const hold = partialPrefixLength(this.buffer, this.open);
          output += this.buffer.slice(0, this.buffer.length - hold);
          this.buffer = this.buffer.slice(this.buffer.length - hold);
          return output;
        }
        output += this.buffer.slice(0, start);
        this.buffer = this.buffer.slice(start + this.open.length);
        this.inside = true;
        continue;
      }
      const end = this.buffer.indexOf(this.close);
      if (end === -1) {
        this.buffer = '';
        return output;
      }
      this.buffer = this.buffer.slice(end + this.close.length);
      this.inside = false;
    }
    return output;
  }

  flush() {
    const rest = this.inside ? '' : this.buffer;
    this.buffer = '';
    return rest;
  }
}

function partialPrefixLength(text, marker) {
  const max = Math.min(marker.length - 1, text.length);
  for (let length = max; length > 0; length -= 1) {
    if (text.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

/** Extract <tool_call>{"name":..,"arguments":{..}}</tool_call> blocks. */
export function extractProtocolToolCalls(rawText) {
  const text = String(rawText ?? '');
  const calls = [];
  const errors = [];
  let cleanText = '';
  let cursor = 0;
  const open = '<tool_call>';
  const close = '</tool_call>';

  while (cursor < text.length) {
    const start = text.indexOf(open, cursor);
    if (start === -1) {
      cleanText += text.slice(cursor);
      break;
    }
    cleanText += text.slice(cursor, start);
    const end = text.indexOf(close, start + open.length);
    if (end === -1) {
      errors.push('Unterminated <tool_call> block (missing </tool_call>).');
      break;
    }
    const body = text.slice(start + open.length, end).trim();
    cursor = end + close.length;
    if (!body) {
      errors.push('Empty <tool_call> block.');
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      errors.push(`Invalid JSON in <tool_call>: ${error.message}`);
      continue;
    }
    const name = parsed?.name ?? parsed?.tool ?? parsed?.function?.name;
    const args = parsed?.arguments ?? parsed?.input ?? parsed?.function?.arguments ?? {};
    if (!name || typeof name !== 'string') {
      errors.push('<tool_call> is missing a "name" field.');
      continue;
    }
    if (args && typeof args === 'string') {
      try {
        calls.push({ name, arguments: JSON.parse(args) });
      } catch (error) {
        errors.push(`Invalid JSON arguments for ${name}: ${error.message}`);
      }
    } else {
      calls.push({ name, arguments: args && typeof args === 'object' ? args : {} });
    }
  }

  return { cleanText: cleanText.trim(), calls, errors };
}

function isToolUnsupportedError(error) {
  if (!error) return false;
  const text = `${error.message ?? ''} ${error.detail ?? ''}`.toLowerCase();
  if (!/tool|function/.test(text)) return false;
  return error.code === ERROR_CODES.BAD_REQUEST || error.httpStatus === 400 || error.httpStatus === 422;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run a full turn: model -> tool calls -> model -> ... until a text answer.
 * Emits structured events for the activity engine; never logs chain-of-thought.
 */
export async function runAgentLoop({
  provider,
  model,
  messages: initialMessages,
  tools = [],
  executeTool,
  maxIterations = 20,
  onEvent = () => {},
  signal = null,
  streaming = true,
  toolMode = 'native',
  temperature = 0.6,
  captureReasoning = true,
  extraBody = null,
} = {}) {
  const messages = [...initialMessages];
  const appended = [];
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let iterations = 0;
  let aborted = false;
  let error = null;
  let finalText = '';
  // Reasoning is accumulated across tool iterations so the final answer keeps
  // one honest "Thought for Xs" panel. It is stored in message metadata only;
  // it is never sent back to the model as context.
  let turnReasoning = '';
  let turnReasoningMs = 0;
  let mode = toolMode === 'fallback' ? 'fallback' : toolMode === 'chat' ? 'chat' : 'native';
  let fallbackSwitches = 0;
  let protocolFailures = 0;
  const toolsUsed = [];

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    iterations = iteration;
    onEvent({ type: 'iteration', iteration, mode, maxIterations });
    onEvent({ type: 'phase', phase: PHASES.THINKING });
    onEvent({ type: 'status', message: `Waiting for model response… (turn ${iteration}/${maxIterations})` });

    let rawText = '';
    let toolCalls = [];
    let finishReason = null;
    const filter = new ToolProtocolFilter();
    let switchToFallback = false;
    let streamStarted = false;
    let transportStreaming = true;

    let iterationReasoning = '';
    let iterationReasoningMs = 0;
    let reasoningOpen = false;
    let reasoningStartedAt = 0;
    let answerStarted = false;

    const openReasoning = () => {
      if (reasoningOpen) return;
      reasoningOpen = true;
      reasoningStartedAt = Date.now();
      if (captureReasoning && streaming) onEvent({ type: EVENTS.REASONING_START });
    };

    const closeReasoning = () => {
      if (!reasoningOpen) return;
      reasoningOpen = false;
      const segmentMs = Math.max(0, Date.now() - reasoningStartedAt);
      iterationReasoningMs += segmentMs;
      if (captureReasoning && streaming) {
        // Per-segment duration; the UI adds segments across tool iterations.
        onEvent({ type: EVENTS.REASONING_COMPLETE, durationMs: segmentMs });
      }
    };

    const reasoningMeta = () =>
      captureReasoning && iterationReasoning
        ? { reasoning: iterationReasoning, reasoningMs: iterationReasoningMs }
        : {};

    try {
      const useTools = mode === 'native';
      const stream = provider.streamChat({
        model,
        messages,
        tools: useTools ? tools : undefined,
        toolChoice: useTools ? 'auto' : undefined,
        temperature,
        signal,
        ...(extraBody ? { extraBody } : {}),
      });

      for await (const event of stream) {
        if (event.type === 'transport') {
          transportStreaming = event.streaming !== false;
        } else if (event.type === 'reasoning') {
          // Explicit provider reasoning only. The parser has already discarded
          // absent/empty/malformed fields; normal answer text is never used.
          if (!captureReasoning || typeof event.text !== 'string' || !event.text) continue;
          openReasoning();
          iterationReasoning += event.text;
          if (streaming) onEvent({ type: EVENTS.REASONING_CHUNK, text: event.text });
        } else if (event.type === 'text') {
          rawText += event.text;
          const visible = mode === 'fallback' ? filter.feed(event.text) : event.text;
          if (visible && streaming) {
            // The first real chunk flips Thinking → Typing. This is actual
            // streaming, not a fake per-character replay of the final answer.
            // Non-streaming fallbacks keep the Thinking phase.
            if (!answerStarted) {
              closeReasoning();
              answerStarted = true;
              onEvent({ type: EVENTS.ANSWER_START });
            }
            if (!streamStarted && transportStreaming) {
              streamStarted = true;
              onEvent({ type: 'phase', phase: PHASES.STREAMING });
            }
            onEvent({ type: 'text', text: visible, streaming: transportStreaming });
            onEvent({ type: EVENTS.ANSWER_CHUNK, text: visible, streaming: transportStreaming });
          }
        } else if (event.type === 'tool_calls') {
          toolCalls = event.toolCalls;
        } else if (event.type === 'usage') {
          usage.promptTokens += event.usage.promptTokens;
          usage.completionTokens += event.usage.completionTokens;
          usage.totalTokens += event.usage.totalTokens;
          onEvent({ type: 'usage', usage: { ...event.usage }, total: { ...usage } });
        } else if (event.type === 'done') {
          finishReason = event.finishReason;
          if (event.toolCalls?.length) toolCalls = event.toolCalls;
        }
      }
    } catch (streamError) {
      if (signal?.aborted || streamError.code === ERROR_CODES.ABORTED) {
        aborted = true;
        if (rawText) {
          const partial = mode === 'fallback' ? extractProtocolToolCalls(rawText).cleanText : rawText;
          if (partial) {
            appended.push({
              role: 'assistant',
              content: partial,
              meta: { aborted: true, model, toolMode: mode, ...reasoningMeta() },
            });
            finalText = partial;
          }
        }
        closeReasoning();
        if (answerStarted) onEvent({ type: EVENTS.ANSWER_COMPLETE });
        onEvent({ type: 'warning', message: 'Request cancelled.' });
        break;
      }
      if (mode === 'native' && fallbackSwitches < 1 && isToolUnsupportedError(streamError)) {
        fallbackSwitches += 1;
        mode = 'fallback';
        switchToFallback = true;
        onEvent({
          type: 'warning',
          message: 'This model rejected native tool calling; switching to the text tool protocol.',
        });
      } else {
        error = streamError;
        closeReasoning();
        if (answerStarted) onEvent({ type: EVENTS.ANSWER_COMPLETE });
        onEvent({ type: 'error', error: streamError });
        break;
      }
    }

    // Close a reasoning segment even if the stream ended without answer text
    // (timeout after reasoning, tool-only turn, cancellation).
    closeReasoning();
    if (answerStarted) onEvent({ type: EVENTS.ANSWER_COMPLETE });

    if (switchToFallback) {
      iteration -= 1; // retry the same turn with the fallback protocol
      continue;
    }

    if (signal?.aborted) {
      aborted = true;
      break;
    }

    if (captureReasoning && iterationReasoning) {
      turnReasoning = turnReasoning ? `${turnReasoning}\n\n${iterationReasoning}` : iterationReasoning;
      turnReasoningMs += iterationReasoningMs;
    }

    if (mode === 'fallback' || mode === 'chat') {
      const tail = filter.flush();
      if (tail && streaming) onEvent({ type: 'text', text: tail });
      const parsed = extractProtocolToolCalls(rawText);
      if (mode === 'fallback' && parsed.calls.length) {
        messages.push({ role: 'assistant', content: rawText });
        appended.push({
          role: 'assistant',
          content: parsed.cleanText || rawText,
          meta: { model, toolMode: mode, ...reasoningMeta() },
        });

        for (const call of parsed.calls) {
          const record = await executeToolCall(call, { executeTool, onEvent, signal, toolsUsed });
          messages.push({
            role: 'user',
            content: `<tool_result name="${call.name}">\n${record.toolResultText}\n</tool_result>`,
          });
          appended.push(record.stored);
          if (signal?.aborted) break;
        }
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        continue;
      }

      if (parsed.errors.length) {
        protocolFailures += 1;
        onEvent({ type: 'warning', message: `Tool protocol error: ${parsed.errors[0]}` });
        if (protocolFailures >= 3) {
          mode = 'chat';
          onEvent({ type: 'warning', message: 'Model cannot follow the tool protocol; continuing in chat-only mode.' });
          continue;
        }
        messages.push({ role: 'assistant', content: rawText });
        messages.push({
          role: 'user',
          content: `Your tool call was not valid: ${parsed.errors.join(' ')} Respond with a corrected <tool_call> block or answer without tools.`,
        });
        continue;
      }

      const answer = parsed.cleanText || rawText.trim();
      if (answer) {
        messages.push({ role: 'assistant', content: answer });
        appended.push({
          role: 'assistant',
          content: answer,
          meta: { model, toolMode: mode, ...reasoningMeta() },
        });
        finalText = answer;
      }
      break;
    }

    // Native tool calling path
    if (toolCalls.length) {
      const assistantMessage = { role: 'assistant', content: rawText || '', tool_calls: toolCalls };
      messages.push(assistantMessage);
      appended.push({
        role: 'assistant',
        content: rawText || '',
        meta: { model, toolMode: mode, toolCalls, ...reasoningMeta() },
      });

      for (const call of toolCalls) {
        if (signal?.aborted) break;
        const record = await executeToolCall(
          {
            name: call.function?.name ?? call.name,
            arguments: call.function?.arguments ?? call.arguments ?? '{}',
            id: call.id,
          },
          { executeTool, onEvent, signal, toolsUsed, toolCallId: call.id },
        );
        messages.push({ role: 'tool', tool_call_id: call.id, content: record.toolResultText });
        appended.push(record.stored);
      }
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      continue;
    }

    const answer = rawText.trim();
    if (answer) {
      messages.push({ role: 'assistant', content: answer });
      appended.push({
        role: 'assistant',
        content: answer,
        meta: { model, toolMode: mode, finishReason, ...reasoningMeta() },
      });
      finalText = answer;
    }
    // A model may return an empty turn with finish_reason=stop; surface it.
    if (!answer && finishReason && finishReason !== 'stop') {
      onEvent({ type: 'warning', message: `Model finished without text (finish_reason=${finishReason}).` });
    }
    break;
  }

  if (iterations >= maxIterations) {
    onEvent({
      type: 'warning',
      message: `Reached the maximum of ${maxIterations} agent iterations. Send another message to continue.`,
    });
  }

  // Give the visible answer one aggregate reasoning panel, even when the
  // reasoning happened in an earlier tool-calling iteration.
  if (captureReasoning && turnReasoning) {
    const finalAssistant = [...appended]
      .reverse()
      .find((record) => record.role === 'assistant' && record.content && !record.meta?.toolCalls?.length);
    if (finalAssistant) {
      finalAssistant.meta = {
        ...(finalAssistant.meta ?? {}),
        reasoning: turnReasoning,
        reasoningMs: turnReasoningMs,
      };
    }
  }

  const result = {
    appended,
    text: finalText,
    usage,
    aborted,
    error,
    iterations,
    toolMode: mode,
    toolsUsed,
    messages,
    reasoning: turnReasoning,
    reasoningMs: turnReasoningMs,
  };
  onEvent({ type: 'phase', phase: aborted ? PHASES.CANCELLED : error ? PHASES.ERROR : PHASES.COMPLETED });
  onEvent({ type: 'done', ...result, messages: undefined });
  return result;
}

function normaliseArguments(value) {
  if (value && typeof value === 'object') return { args: value, error: null };
  const text = String(value ?? '').trim();
  if (!text) return { args: {}, error: null };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { args: parsed, error: null };
    return { args: {}, error: 'Tool arguments must be a JSON object.' };
  } catch (error) {
    return { args: {}, error: `Invalid JSON arguments: ${error.message}` };
  }
}

async function executeToolCall(call, { executeTool, onEvent, signal, toolsUsed, toolCallId = null }) {
  const name = String(call?.name ?? '').trim();
  const { args, error: argumentError } = normaliseArguments(call?.arguments);
  const startedAt = Date.now();

  if (argumentError) {
    const message = `TOOL ERROR (INVALID_JSON): ${argumentError}. Provide arguments as a valid JSON object.`;
    onEvent({ type: 'tool-start', toolName: name, input: null, invalid: true });
    onEvent({ type: 'tool-end', toolName: name, ok: false, error: argumentError, durationMs: 0 });
    return {
      stored: {
        role: 'tool',
        content: message,
        toolName: name,
        meta: { ok: false, errorCode: 'INVALID_JSON', toolCallId },
      },
      toolResultText: message,
    };
  }

  onEvent({ type: 'phase', phase: PHASES.TOOL_EXECUTION });
  onEvent({ type: 'tool-start', toolName: name, input: args });

  let result;
  try {
    result = await withTimeout(
      Promise.resolve(executeTool(name, args, { signal })),
      TOOL_TIMEOUT_MS,
      `Tool ${name}`,
    );
  } catch (error) {
    result = { ok: false, error: error?.message ?? String(error), errorCode: error?.code ?? 'TOOL_FAILED' };
  }

  const durationMs = Date.now() - startedAt;
  if (result?.ok) toolsUsed.push(name);

  if (result?.ok) {
    onEvent({
      type: 'tool-end',
      toolName: name,
      ok: true,
      durationMs,
      display: result.display ?? null,
      meta: result.meta ?? null,
      truncated: result.truncated ?? false,
    });
    const text = result.truncated
      ? `${result.output}\n\n[output truncated by the agent]`
      : result.output;
    return {
      stored: {
        role: 'tool',
        content: text,
        toolName: name,
        meta: { ok: true, toolCallId, durationMs, ...(result.meta ?? {}) },
      },
      toolResultText: text,
    };
  }

  const errorText = `TOOL ERROR (${result?.errorCode ?? 'FAILED'}): ${result?.error ?? 'unknown error'}`;
  onEvent({
    type: 'tool-end',
    toolName: name,
    ok: false,
    error: result?.error ?? 'unknown error',
    errorCode: result?.errorCode ?? 'FAILED',
    durationMs,
  });
  return {
    stored: {
      role: 'tool',
      content: errorText,
      toolName: name,
      meta: { ok: false, errorCode: result?.errorCode ?? 'FAILED', toolCallId, durationMs },
    },
    toolResultText: errorText,
  };
}

export { ProviderError, isToolUnsupportedError };
