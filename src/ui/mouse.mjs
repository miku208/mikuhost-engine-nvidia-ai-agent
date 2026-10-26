// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
export const MOUSE_ENABLE = '\u001b[?1000h\u001b[?1006h';
export const MOUSE_DISABLE = '\u001b[?1000l\u001b[?1006l';

/**
 * Parse an SGR mouse report: ESC [ < button ; col ; row M/m
 * Returns null for anything that is not a mouse report.
 */
export function parseSgrMouse(input) {
  // Ink's key parser strips the leading ESC, so accept both forms.
  const match = /^(?:\u001b)?\[<(\d+);(\d+);(\d+)([Mm])$/.exec(String(input ?? ''));
  if (!match) return null;
  const button = Number(match[1]);
  return {
    button,
    x: Number(match[2]),
    y: Number(match[3]),
    release: match[4] === 'm',
    wheel: (button & 64) !== 0,
    wheelUp: (button & 64) !== 0 && (button & 1) === 0,
    wheelDown: (button & 64) !== 0 && (button & 1) === 1,
    motion: (button & 32) !== 0,
  };
}

export function mouseEnabled(config) {
  if (process.env.MIKUHOST_MOUSE === '0') return false;
  return config?.get?.().ui?.mouse !== false;
}
