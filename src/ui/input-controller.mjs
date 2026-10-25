import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createBracketedPasteCapture } from '../paste/attachments.mjs';

/**
 * Single owner of the terminal input stream.
 *
 *   process.stdin -> InputController -> filtered stream -> Ink / composer
 *                            \-> paste buffer -> attachment manager
 *
 * Ink's input parser turns every ESC into a key event. That is why a bracketed
 * paste split across reads used to reach the composer: `ESC` cleared the
 * prompt, `[200~` was typed as text, and only part of the payload arrived.
 *
 * This controller reads the raw bytes first, removes the paste block (including
 * markers split down to single bytes), and hands Ink a stream that never
 * contains pasted content. A completed block is published through `onPaste`
 * exactly once, so the app turns it into exactly one attachment.
 *
 * No second stdin listener parses input; Ink reads the filtered PassThrough
 * stream instead of process.stdin.
 */
export class InputController {
  constructor({ stdin = process.stdin, trace = null, holdMs = 30 } = {}) {
    this.stdin = stdin;
    this.trace = trace;
    this.holdMs = holdMs;
    this.capture = createBracketedPasteCapture({ holdLoneEscape: true });
    this.decoder = new StringDecoder('utf8');
    this.listeners = new Set();
    this.timer = null;
    this.started = false;
    this.lastRaw = null;
    // Enabling bracketed paste in the terminal does not prove the client sends
    // the markers. Only an actual start marker sets this.
    this.bracketedReceived = false;
    this.pasteSequence = 0;

    // Ink reads from this stream, so it can never observe paste bytes.
    this.input = new PassThrough();
    this.input.isTTY = Boolean(stdin?.isTTY);
    // Raw mode still belongs to the real terminal; Ink only needs the API.
    this.input.setRawMode = (mode) => {
      if (typeof stdin?.setRawMode === 'function') stdin.setRawMode(Boolean(mode));
    };
    // stream.Readable has no ref()/unref(); Ink calls them to keep the loop
    // alive while it is reading. The real stdin already does that for us.
    this.input.ref = () => {};
    this.input.unref = () => {};

    this.handleData = this.handleData.bind(this);
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.stdin?.on?.('data', this.handleData);
    return this;
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.stdin?.off?.('data', this.handleData);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Any held text (never paste payload) is released so an unmount does not
    // silently swallow the last keystroke.
    const text = this.capture.flushText();
    if (text) this.input.write(text);
  }

  /** Subscribe to completed paste blocks. Returns an unsubscribe function. */
  onPaste(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Send plain text through Ink (used by the setup wizard and tests). */
  injectText(text) {
    if (text) this.input.write(String(text));
  }

  /** Raw bytes for the Ink event currently being dispatched (DEL vs Delete). */
  takeRaw() {
    const raw = this.lastRaw;
    this.lastRaw = null;
    return raw;
  }

  handleData(chunk) {
    const bytes = typeof chunk === 'string' ? chunk : Buffer.byteLength(chunk);
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (!text) return;

    const wasPasting = this.capture.active;
    const result = this.capture.feed(text);
    if (!wasPasting && this.capture.active) this.bracketedReceived = true;
    this.trace?.feed({
      bytes: typeof bytes === 'number' ? bytes : text.length,
      state: this.capture.state,
      pasteActive: this.capture.active,
      pending: Boolean(this.capture.pendingText),
      inputBytes: result.text.length,
      bracketed: this.bracketedReceived,
    });

    // Publish first: if the same read also contains Enter, the attachment is
    // already in React state when the key event is dispatched.
    for (const paste of result.pastes ?? []) this.publish(paste);
    if (result.text) this.write(result.text);
    this.scheduleCarryFlush();
  }

  write(text) {
    if (!text) return;
    // Only displayed text reaches Ink. Keeping the raw chunk here preserves
    // Backspace (0x7f) versus forward Delete (ESC[3~) detection.
    this.lastRaw = text;
    this.input.write(text);
  }

  publish(content) {
    const pasteId = (this.pasteSequence += 1);
    this.trace?.paste({ phase: 'finish', id: pasteId, chars: String(content ?? '').length });
    for (const listener of this.listeners) {
      try {
        listener(content);
      } catch {
        /* a paste listener must never break the input stream */
      }
    }
  }

  /**
   * A lone ESC or "[" may be the beginning of a marker split across reads, so
   * it is held briefly. If nothing follows, it is a normal key and is released.
   * While a bracketed paste is open nothing is released: only ESC[201~ ends it.
   */
  scheduleCarryFlush() {
    if (this.timer) clearTimeout(this.timer);
    if (this.capture.state !== 'normal' || !this.capture.pendingText) {
      this.timer = null;
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      const text = this.capture.flushText();
      if (text) this.write(text);
    }, this.holdMs);
    this.timer.unref?.();
  }
}

export function createInputController(options) {
  return new InputController(options);
}
