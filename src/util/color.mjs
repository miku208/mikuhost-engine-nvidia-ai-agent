// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
const enabled =
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb' &&
  Boolean(process.stdout.isTTY) &&
  process.env.MIKUHOST_COLOR !== '0';

function wrap(open, close) {
  return (value) => (enabled ? `\u001b[${open}m${String(value)}\u001b[${close}m` : String(value));
}

export const color = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  italic: wrap('3', '23'),
  red: wrap('31', '39'),
  green: wrap('38;5;114', '39'),
  yellow: wrap('33', '39'),
  blue: wrap('34', '39'),
  magenta: wrap('35', '39'),
  cyan: wrap('36', '39'),
  gray: wrap('38;5;245', '39'),
  white: wrap('97', '39'),
};

export function statusDot(ok) {
  return ok ? color.green('●') : color.red('●');
}

export function ok(value) {
  return color.green(value);
}

export function warn(value) {
  return color.yellow(value);
}

export function fail(value) {
  return color.red(value);
}

export const colorsEnabled = enabled;
