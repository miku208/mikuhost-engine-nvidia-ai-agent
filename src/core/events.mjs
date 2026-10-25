export const PHASES = Object.freeze({
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  THINKING: 'THINKING',
  TOOL_EXECUTION: 'TOOL_EXECUTION',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  STREAMING: 'STREAMING',
  COMPLETED: 'COMPLETED',
  ERROR: 'ERROR',
  CANCELLED: 'CANCELLED',
});

export const EVENTS = Object.freeze({
  STATUS: 'status',
  PHASE: 'phase',
  /** Final-answer chunk. Kept for compatibility; ANSWER_CHUNK is the new name. */
  TEXT: 'text',
  ANSWER_START: 'answer:start',
  ANSWER_CHUNK: 'answer:chunk',
  ANSWER_COMPLETE: 'answer:complete',
  REASONING_START: 'reasoning:start',
  REASONING_CHUNK: 'reasoning:chunk',
  REASONING_COMPLETE: 'reasoning:complete',
  MESSAGE: 'message',
  TOOL_START: 'tool-start',
  TOOL_END: 'tool-end',
  TOOL_APPROVAL: 'tool-approval',
  USAGE: 'usage',
  WARNING: 'warning',
  ERROR: 'error',
  DONE: 'done',
  ITERATION: 'iteration',
});

/** Tiny synchronous event bus; the TUI subscribes to render activity. */
export function createEmitter() {
  const listeners = new Set();
  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          /* a broken listener must not break the agent loop */
        }
      }
    },
    clear() {
      listeners.clear();
    },
    get size() {
      return listeners.size;
    },
  };
}
