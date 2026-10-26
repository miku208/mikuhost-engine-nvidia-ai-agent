// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
export function clampOffset(offset, maxScroll) {
  const max = Math.max(0, Number(maxScroll) || 0);
  return Math.max(0, Math.min(max, Number(offset) || 0));
}

/**
 * `offset` is measured from the bottom (0 = auto-follow). This lets streaming
 * append lines without changing what a user is reading: when N lines arrive,
 * the distance from the bottom grows by N.
 */
export function viewportMetrics({ lineCount = 0, height = 1, offset = 0 } = {}) {
  const viewportHeight = Math.max(1, Math.floor(height) || 1);
  const maxScroll = Math.max(0, lineCount - viewportHeight);
  const effectiveOffset = clampOffset(offset, maxScroll);
  const start = Math.max(0, maxScroll - effectiveOffset);
  const end = Math.min(lineCount, start + viewportHeight);
  return {
    height: viewportHeight,
    maxScroll,
    offset: effectiveOffset,
    start,
    end,
    atBottom: effectiveOffset === 0,
    hasNewBelow: effectiveOffset > 0,
  };
}

/** Keep the same transcript lines visible when new content is appended below. */
export function anchorOffset(offset, addedLines, maxScroll) {
  const current = clampOffset(offset, maxScroll);
  if (current === 0) return 0;
  return clampOffset(current + Math.max(0, addedLines || 0), maxScroll);
}

export function scrollBy(offset, delta, maxScroll) {
  return clampOffset((Number(offset) || 0) + (Number(delta) || 0), maxScroll);
}

export function shouldShowNewOutput({ offset = 0, activity = false } = {}) {
  return offset > 0 && Boolean(activity);
}
