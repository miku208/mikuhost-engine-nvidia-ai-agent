// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
/**
 * Minimal LCS-based line diff. Deliberately small: it exists to show a human
 * what a write/edit will change before approval, not to produce git-applicable
 * patches.
 */
export function diffLines(oldText, newText, { context = 3, maxLines = 200 } = {}) {
  const oldLines = String(oldText ?? '').split('\n');
  const newLines = String(newText ?? '').split('\n');

  // Fast path: identical.
  if (oldText === newText) return { text: '', added: 0, removed: 0 };

  const ops = lcsDiff(oldLines, newLines);
  const lines = [];
  let added = 0;
  let removed = 0;

  // Attach context by tracking which op indices are "interesting".
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.type !== 'equal') {
      for (let cursor = Math.max(0, index - context); cursor <= Math.min(ops.length - 1, index + context); cursor += 1) {
        keep[cursor] = true;
      }
    }
  });

  let skipping = false;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      if (!skipping) {
        lines.push('…');
        skipping = true;
      }
      return;
    }
    skipping = false;
    if (op.type === 'equal') {
      lines.push(`  ${op.value}`);
    } else if (op.type === 'remove') {
      lines.push(`- ${op.value}`);
      removed += 1;
    } else {
      lines.push(`+ ${op.value}`);
      added += 1;
    }
  });

  let text = lines.join('\n');
  if (lines.length > maxLines) {
    text = `${lines.slice(0, maxLines).join('\n')}\n… diff truncated (${lines.length - maxLines} more lines)`;
  }
  return { text, added, removed };
}

function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;

  // Guard against pathological inputs (large files): fall back to a whole-file
  // replace diff instead of an O(n*m) table.
  if (n * m > 4_000_000) {
    return [
      ...a.map((value) => ({ type: 'remove', value })),
      ...b.map((value) => ({ type: 'add', value })),
    ];
  }

  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', value: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: 'remove', value: a[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', value: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'remove', value: a[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'add', value: b[j] });
    j += 1;
  }
  return ops;
}
