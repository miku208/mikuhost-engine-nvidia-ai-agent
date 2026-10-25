import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/paths.mjs';

/**
 * Opt-in input diagnostics (`MIKUHOST_INPUT_TRACE=1`).
 *
 * Records metadata only: event id, byte count, parser state, paste operation id,
 * attachment finalisation and bytes written to the composer. Pasted content,
 * typed characters and API keys are never accepted by this API and never logged.
 */
export function createInputTrace({ env = process.env, file = null } = {}) {
  const enabled = env.MIKUHOST_INPUT_TRACE === '1';
  const target = file ?? path.join(paths.logs(), 'input-trace.log');
  let sequence = 0;

  const write = (record) => {
    if (!enabled) return;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      /* tracing must never break the UI */
    }
  };

  return {
    enabled,
    file: target,
    feed({ bytes = 0, state = 'normal', pasteActive = false, pending = false, event = null, inputBytes = 0, hasRaw = false } = {}) {
      write({
        ts: Date.now(),
        id: (sequence += 1),
        kind: 'feed',
        bytes: Number(bytes) || 0,
        state,
        pasteActive: Boolean(pasteActive),
        pending: Boolean(pending),
        event: event == null ? null : Number(event),
        inputBytes: Number(inputBytes) || 0,
        hasRaw: Boolean(hasRaw),
      });
    },
    paste({ phase = 'finish', id = null, chars = 0 } = {}) {
      write({ ts: Date.now(), id: (sequence += 1), kind: 'paste', phase, pasteId: id, chars: Number(chars) || 0 });
    },
    attachment({ id = null, chars = 0, ok = true } = {}) {
      write({ ts: Date.now(), id: (sequence += 1), kind: 'attachment', attachmentId: id, chars: Number(chars) || 0, ok: Boolean(ok) });
    },
    composer({ bytes = 0, source = 'paste' } = {}) {
      write({ ts: Date.now(), id: (sequence += 1), kind: 'composer', bytes: Number(bytes) || 0, source });
    },
  };
}
