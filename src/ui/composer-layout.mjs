// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import { displayWidth } from './text-layout.mjs';

function sliceByColumns(text, columns) {
  let width = 0;
  let index = 0;
  for (const char of String(text ?? '')) {
    const charWidth = displayWidth(char);
    if (width + charWidth > columns) break;
    width += charWidth;
    index += char.length;
  }
  const next = text.slice(index, index + 1) ? [...text.slice(index)][0] ?? '' : '';
  return {
    before: text.slice(0, index),
    at: next || ' ',
    after: text.slice(index + next.length),
  };
}

/**
 * Wrap the composer buffer by display columns and place the caret. Logical
 * newlines are preserved. Only a window of at most `maxLines` is returned so a
 * huge paste can never make the composer fill the screen.
 */
export function buildComposerLayout({ value = '', cursor = 0, width = 40, maxLines = 5 } = {}) {
  const text = String(value ?? '');
  const columns = Math.max(8, Math.floor(Number(width) || 40));
  const lineLimit = Math.max(1, Math.floor(Number(maxLines) || 5));
  const caret = Math.max(0, Math.min(Number(cursor) || 0, text.length));

  const ranges = [];
  let start = 0;
  let column = 0;
  for (let index = 0; index < text.length; ) {
    const char = text[index];
    if (char === '\n') {
      ranges.push({ start, end: index });
      start = index + 1;
      index += 1;
      column = 0;
      continue;
    }
    const symbol = String.fromCodePoint(text.codePointAt(index));
    const charWidth = displayWidth(symbol);
    if (column > 0 && column + charWidth > columns) {
      ranges.push({ start, end: index });
      start = index;
      column = 0;
    }
    column += charWidth;
    index += symbol.length;
  }
  ranges.push({ start, end: text.length });

  let cursorLine = ranges.findIndex((range) => caret >= range.start && caret <= range.end);
  if (cursorLine === -1) cursorLine = ranges.length - 1;

  const totalLines = ranges.length;
  const windowStart = Math.max(0, Math.min(cursorLine - Math.floor(lineLimit / 2), totalLines - lineLimit));
  const visible = ranges.slice(windowStart, windowStart + lineLimit).map((range, index) => {
    const raw = text.slice(range.start, range.end);
    const lineIndex = windowStart + index;
    if (lineIndex !== cursorLine) {
      return { before: raw, at: null, after: '', isCursor: false, start: range.start, end: range.end };
    }
    const caretColumn = displayWidth(text.slice(range.start, caret));
    const sliced = sliceByColumns(raw, caretColumn);
    return { ...sliced, isCursor: true, start: range.start, end: range.end };
  });

  return {
    lines: visible,
    totalLines,
    cursorLine,
    hiddenAbove: windowStart,
    hiddenBelow: Math.max(0, totalLines - (windowStart + visible.length)),
    columns,
  };
}

/** Top and bottom border of the composer container. */
export const COMPOSER_BORDER_ROWS = 2;

/** Hard cap for the whole composer box, borders and attachment chips included. */
export function composerBudget(rows = 24) {
  if (rows < 14) return 3;
  if (rows < 22) return 4;
  return 6;
}

export function maxComposerLines(rows = 24) {
  return Math.max(1, composerBudget(rows) - COMPOSER_BORDER_ROWS);
}

/**
 * Text rows left after the border and attachment chips. This is what keeps the
 * composer compact on Android: adding chips shrinks the editor, it never grows
 * the fixed bottom area beyond `composerBudget`.
 */
export function composerTextLines(rows = 24, attachmentRows = 0) {
  const chips = Math.max(0, Math.min(Number(attachmentRows) || 0, maxAttachmentRows(rows)));
  return Math.max(1, Math.min(maxComposerLines(rows), composerBudget(rows) - COMPOSER_BORDER_ROWS - chips));
}

export function maxAttachmentRows(rows = 24) {
  if (rows < 14) return 0;
  if (rows < 22) return 1;
  return 2;
}

export function visibleAttachmentRows(count, limit) {
  if (count <= 0 || limit <= 0) return 0;
  return Math.min(count, limit);
}

export function composerAttachmentRows(count, rows = 24) {
  return visibleAttachmentRows(Number(count) || 0, maxAttachmentRows(rows));
}

/**
 * Pick the attachment cards that fit next to the composer. When a card is
 * selected it is always kept in the window, so Tab/Esc works even with more
 * attachments than the terminal can show at once.
 *
 * One of the rows is reserved for the "+N more" indicator when they overflow.
 */
export function attachmentWindow(attachments = [], limit = 2, selectedId = null) {
  const list = Array.isArray(attachments) ? attachments : [];
  const slots = Math.max(0, Math.floor(Number(limit) || 0));
  if (!list.length || slots <= 0) return { items: [], hidden: list.length, start: 0 };
  if (list.length <= slots) return { items: list, hidden: 0, start: 0 };

  const visibleSlots = Math.max(1, slots - 1);
  const selectedIndex = selectedId ? list.findIndex((attachment) => attachment?.id === selectedId) : -1;
  const start =
    selectedIndex >= 0
      ? Math.min(Math.max(0, selectedIndex - visibleSlots + 1), list.length - visibleSlots)
      : list.length - visibleSlots;
  const items = list.slice(start, start + visibleSlots);
  return { items, hidden: list.length - items.length, start };
}

/** Row offset (0-based, from the first attachment card) for a click, or -1. */
export function attachmentIndexAtOffset(offset, count) {
  const index = Math.floor(Number(offset));
  return index >= 0 && index < (Number(count) || 0) ? index : -1;
}
