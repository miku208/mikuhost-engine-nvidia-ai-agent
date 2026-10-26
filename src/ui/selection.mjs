// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
/**
 * Small, pure helpers for the composer selection model. Keeping the decisions
 * here makes keyboard/mouse behaviour testable without rendering Ink.
 */

/** Stable identity for a selectable item: string id or `{ kind, id }`. */
export function selectionKey(item) {
  if (item === null || item === undefined) return null;
  if (typeof item === 'string') return item;
  if (typeof item.id === 'string' || typeof item.id === 'number') return `${item.kind ?? 'item'}:${item.id}`;
  return null;
}

/**
 * Cycle through selectable cards. `null` means the composer has focus.
 * After the last card the selection returns to the composer, so Tab never
 * traps the user on a card.
 */
export function cycleSelection(current, items = [], direction = 1) {
  const list = Array.isArray(items) ? items.filter((item) => selectionKey(item)) : [];
  if (!list.length) return null;
  const key = selectionKey(current);
  const index = key === null ? -1 : list.findIndex((item) => selectionKey(item) === key);
  const step = direction < 0 ? -1 : 1;

  if (index === -1) return step > 0 ? list[0] : list[list.length - 1];
  const next = index + step;
  if (next < 0) return list[list.length - 1];
  if (next >= list.length) return null;
  return list[next];
}

/** Remove exactly one attachment; the rest keep their order. */
export function removeAttachmentById(attachments = [], id) {
  if (!id) return Array.isArray(attachments) ? [...attachments] : [];
  return (Array.isArray(attachments) ? attachments : []).filter((attachment) => attachment?.id !== id);
}

/**
 * Decide what Escape means, in priority order:
 *   modal dialog > panel > selected attachment > selected reasoning > normal.
 * A modal must win so Escape can never delete a composer attachment while the
 * user is answering a confirmation.
 */
export function escapeAction({
  modalActive = false,
  panel = null,
  selectedAttachmentId = null,
  reasoningSelected = false,
  hasInput = false,
} = {}) {
  if (modalActive) return { type: 'modal' };
  if (panel) return { type: 'close-panel', panel };
  if (selectedAttachmentId) return { type: 'remove-attachment', id: selectedAttachmentId };
  if (reasoningSelected) return { type: 'collapse-reasoning' };
  return { type: hasInput ? 'clear-input' : 'scroll-bottom' };
}

/** Resolve a click on the live transcript viewport to its source line. */
export function lineAtRow({ row, topPadding = 0, lines = [] } = {}) {
  const index = Math.floor(Number(row)) - Math.max(0, Math.floor(Number(topPadding) || 0));
  if (index < 0 || index >= lines.length) return null;
  return lines[index] ?? null;
}
