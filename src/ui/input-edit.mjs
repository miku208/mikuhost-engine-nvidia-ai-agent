// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const META_BACKSPACE = /^\u001b+[\u007f\u0008]+$/;
const PASTE_MARKERS = /\u001b\[20[01]~|\[20[01]~/g;

/**
 * Ink splits a bracketed paste into marker events (`[200~`, content, `[201~`).
 * Strip the markers so clipboard text lands cleanly instead of typing them.
 */
function stripPasteMarkers(text) {
  return String(text ?? '').replace(PASTE_MARKERS, '');
}

let segmenter = null;
try {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  }
} catch {
  segmenter = null;
}

/**
 * Grapheme-aware boundaries.
 *
 * Terminals and Android SSH keyboards send UTF-8; deleting one code point of an
 * emoji or a combining sequence leaves broken text on screen. Intl.Segmenter is
 * available on Node 20+, and the fallback still keeps surrogate pairs together.
 */
function graphemeRanges(text) {
  if (segmenter) {
    const ranges = [];
    for (const { index, segment } of segmenter.segment(text)) {
      ranges.push({ start: index, end: index + segment.length });
    }
    return ranges;
  }
  const ranges = [];
  let index = 0;
  for (const char of text) {
    ranges.push({ start: index, end: index + char.length });
    index += char.length;
  }
  return ranges;
}

export function previousGrapheme(text, position) {
  const pos = Math.max(0, Math.min(Number(position) || 0, text.length));
  if (pos === 0) return 0;
  // The grapheme immediately before the caret is the first one whose end
  // reaches the caret. Returning its start makes Backspace work at any cursor
  // position, not only at the end of the line.
  for (const range of graphemeRanges(text)) {
    if (range.end >= pos) return range.start;
  }
  return Math.max(0, pos - 1);
}

export function nextGrapheme(text, position) {
  const pos = Math.max(0, Math.min(Number(position) || 0, text.length));
  if (pos >= text.length) return text.length;
  for (const range of graphemeRanges(text)) {
    if (range.end > pos) return range.end;
  }
  return text.length;
}

function deleteBackward(text, position) {
  if (position <= 0) return { changed: false, value: text, cursor: position };
  const start = previousGrapheme(text, position);
  return {
    changed: true,
    value: text.slice(0, start) + text.slice(position),
    cursor: start,
  };
}

function deleteForward(text, position) {
  if (position >= text.length) return { changed: false, value: text, cursor: position };
  const end = nextGrapheme(text, position);
  return {
    changed: true,
    value: text.slice(0, position) + text.slice(end),
    cursor: position,
  };
}

function insertText(text, position, insertion) {
  return {
    changed: true,
    value: text.slice(0, position) + insertion + text.slice(position),
    cursor: position + insertion.length,
  };
}

/**
 * Apply a raw stream chunk exactly as the terminal delivered it.
 *
 * A single data event can contain text, the backspace byte (0x7f/0x08), or both
 * when SSH or an Android keyboard batches keystrokes. Processing the chunk
 * sequentially is what keeps `helloo<DEL>` working when Ink hands us
 * `"helloo\u007f"` instead of reporting key.backspace.
 */
function applyChunk(text, value, position, { allowControl = true } = {}) {
  let output = value;
  let cursor = position;
  let changed = false;
  let pending = '';

  const flush = () => {
    if (!pending) return;
    const inserted = insertText(output, cursor, pending);
    output = inserted.value;
    cursor = inserted.cursor;
    changed = true;
    pending = '';
  };

  for (let index = 0; index < text.length; ) {
    const char = text[index];
    const code = text.codePointAt(index);

    if (char === '\u007f' || char === '\b') {
      flush();
      if (!allowControl) return { changed, value: output, cursor };
      const result = deleteBackward(output, cursor);
      output = result.value;
      cursor = result.cursor;
      changed = changed || result.changed;
      index += 1;
      continue;
    }

    // Pasted newlines and tabs collapse to a single space, matching how a
    // single-line prompt should accept multi-line clipboard content.
    if (char === '\r' || char === '\n' || char === '\t') {
      flush();
      const inserted = insertText(output, cursor, ' ');
      output = inserted.value;
      cursor = inserted.cursor;
      changed = true;
      index += 1;
      while (index < text.length && (text[index] === '\r' || text[index] === '\n' || text[index] === '\t')) {
        index += 1;
      }
      continue;
    }

    if (code < 0x20 || code === 0x7f) {
      index += 1;
      continue;
    }

    const symbol = String.fromCodePoint(code);
    pending += symbol;
    index += symbol.length;
  }

  flush();
  return { changed, value: output, cursor };
}

function decodeRaw(rawInput) {
  if (rawInput === null || rawInput === undefined) return null;
  if (Buffer.isBuffer(rawInput)) return rawInput.toString('utf8');
  if (ArrayBuffer.isView(rawInput)) {
    return Buffer.from(rawInput.buffer, rawInput.byteOffset, rawInput.byteLength).toString('utf8');
  }
  return String(rawInput);
}

/**
 * Apply a keypress to a single-line buffer. Returns the new value + cursor.
 * Callers stay in full control of which keys are global shortcuts.
 *
 * @param {string} value current buffer
 * @param {number} cursor caret offset
 * @param {string} input normalized text from Ink
 * @param {object} key normalized flags from Ink
 * @param {Buffer|string|null} rawInput the exact bytes from stdin for this event
 */
/** Insert already-sanitised text (used by paste cards and newline insertion). */
export function insertPlainText(value, cursor, text) {
  const source = String(value ?? '');
  const pos = Math.max(0, Math.min(Number(cursor) || 0, source.length));
  const cleaned = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    // Keep newlines; drop other C0 controls and DEL so pasted ANSI cannot
    // repaint the terminal.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (!cleaned) return { changed: false, value: source, cursor: pos };
  return { changed: true, value: source.slice(0, pos) + cleaned + source.slice(pos), cursor: pos + cleaned.length };
}

/** Move the caret one logical line up/down when the buffer is multiline. */
export function moveCursorVertical(value, cursor, direction) {
  const text = String(value ?? '');
  const pos = Math.max(0, Math.min(Number(cursor) || 0, text.length));
  if (!text.includes('\n')) return { changed: false, value: text, cursor: pos };
  const lineStart = text.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
  const column = pos - lineStart;
  if (direction < 0) {
    if (lineStart === 0) return { changed: false, value: text, cursor: pos };
    const previousEnd = lineStart - 1;
    const previousStart = text.lastIndexOf('\n', Math.max(0, previousEnd - 1)) + 1;
    return { changed: true, value: text, cursor: Math.min(previousEnd, previousStart + column) };
  }
  const nextBreak = text.indexOf('\n', pos);
  if (nextBreak === -1) return { changed: false, value: text, cursor: pos };
  const nextStart = nextBreak + 1;
  const nextEnd = text.indexOf('\n', nextStart);
  const limit = nextEnd === -1 ? text.length : nextEnd;
  return { changed: true, value: text, cursor: Math.min(limit, nextStart + column) };
}

export function applyTextInput(value, cursor, input, key = {}, rawInput = null) {
  const text = String(value ?? '');
  const pos = Math.max(0, Math.min(Number.isFinite(Number(cursor)) ? Number(cursor) : text.length, text.length));
  const raw = decodeRaw(rawInput);

  if (key.ctrl) {
    switch (String(input ?? '').toLowerCase()) {
      case 'a':
        return { changed: true, value: text, cursor: 0 };
      case 'e':
        return { changed: true, value: text, cursor: text.length };
      case 'u':
        return { changed: true, value: text.slice(pos), cursor: 0 };
      case 'k':
        return { changed: true, value: text.slice(0, pos), cursor: pos };
      case 'w': {
        const before = text.slice(0, pos);
        const trimmed = before.replace(/\s+$/, '');
        const cut = Math.max(trimmed.lastIndexOf(' '), trimmed.lastIndexOf('\t'));
        const start = cut === -1 ? 0 : cut + 1;
        return { changed: true, value: text.slice(0, start) + text.slice(pos), cursor: start };
      }
      default:
        return { changed: false, value: text, cursor: pos };
    }
  }

  if (key.leftArrow) return { changed: true, value: text, cursor: previousGrapheme(text, pos) };
  if (key.rightArrow) return { changed: true, value: text, cursor: nextGrapheme(text, pos) };
  if (key.home) return { changed: true, value: text, cursor: 0 };
  if (key.end) return { changed: true, value: text, cursor: text.length };

  // Raw bytes are authoritative. This is what distinguishes a real Backspace
  // (0x7f or 0x08) from a forward Delete (ESC [ 3 ~), which Ink normalizes to
  // the same key.delete flag.
  if (raw !== null) {
    if (/\u001b\[20[01]~/.test(raw)) {
      // Let Ink's marker/content events flow through the normalized fallback
      // below, with the paste delimiters removed.
    } else if (!raw.includes('\u001b')) {
      return applyChunk(raw, text, pos);
    } else if (META_BACKSPACE.test(raw)) {
      let result = { changed: false, value: text, cursor: pos };
      const presses = Math.max(1, raw.replace(/^\u001b+/, '').length);
      for (let index = 0; index < presses; index += 1) {
        if (result.cursor <= 0) break;
        result = deleteBackward(result.value, result.cursor);
      }
      return result;
    }
    // Arrow/Delete/mouse escape sequences keep Ink's normalized flags below.
  }

  if (key.backspace) return deleteBackward(text, pos);
  if (key.delete) return deleteForward(text, pos);

  // No raw bytes (direct calls, tests, or Ink eating the sequence): fall back
  // to the normalized text, still treating embedded DEL/BS bytes correctly.
  if (typeof input === 'string' && input) {
    const withoutMarkers = stripPasteMarkers(input);
    if (!withoutMarkers) return { changed: false, value: text, cursor: pos };
    if (/[\u007f\b\r\n\t]/.test(withoutMarkers)) return applyChunk(withoutMarkers, text, pos);
    if (key.meta) return { changed: false, value: text, cursor: pos };
    const cleaned = withoutMarkers.replace(CONTROL_CHARS, '');
    if (!cleaned) return { changed: false, value: text, cursor: pos };
    return insertText(text, pos, cleaned);
  }

  return { changed: false, value: text, cursor: pos };
}
