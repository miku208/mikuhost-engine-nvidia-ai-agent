// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import { h } from './h.mjs';
import { theme } from './theme.mjs';
import { useRawInput } from './hooks/use-raw-input.mjs';

const SEQUENCES = [
  { pattern: /^\u001b\[3~$/, kind: 'delete', label: 'DELETE (forward)', detail: 'ESC [ 3 ~' },
  { pattern: /^\u001b\[2~$/, kind: 'insert', label: 'INSERT', detail: 'ESC [ 2 ~' },
  { pattern: /^\u001b\[(?:1|7)~$/, kind: 'home', label: 'HOME', detail: 'ESC [ 1 ~' },
  { pattern: /^\u001b\[(?:4|8)~$/, kind: 'end', label: 'END', detail: 'ESC [ 4 ~' },
  { pattern: /^\u001b\[(?:1;5|5)D$/, kind: 'word-left', label: 'CTRL+LEFT', detail: 'word left' },
  { pattern: /^\u001b\[(?:1;5|5)C$/, kind: 'word-right', label: 'CTRL+RIGHT', detail: 'word right' },
  { pattern: /^\u001b\[H$/, kind: 'home', label: 'HOME', detail: 'ESC [ H' },
  { pattern: /^\u001b\[F$/, kind: 'end', label: 'END', detail: 'ESC [ F' },
  { pattern: /^\u001b\[A$/, kind: 'up', label: 'ARROW UP', detail: 'ESC [ A' },
  { pattern: /^\u001b\[B$/, kind: 'down', label: 'ARROW DOWN', detail: 'ESC [ B' },
  { pattern: /^\u001b\[C$/, kind: 'right', label: 'ARROW RIGHT', detail: 'ESC [ C' },
  { pattern: /^\u001b\[D$/, kind: 'left', label: 'ARROW LEFT', detail: 'ESC [ D' },
  { pattern: /^\u001bOA$/, kind: 'up', label: 'ARROW UP', detail: 'ESC O A' },
  { pattern: /^\u001bOB$/, kind: 'down', label: 'ARROW DOWN', detail: 'ESC O B' },
  { pattern: /^\u001bOC$/, kind: 'right', label: 'ARROW RIGHT', detail: 'ESC O C' },
  { pattern: /^\u001bOD$/, kind: 'left', label: 'ARROW LEFT', detail: 'ESC O D' },
];

function toText(rawInput) {
  if (rawInput === null || rawInput === undefined) return null;
  if (Buffer.isBuffer(rawInput)) return rawInput.toString('utf8');
  if (ArrayBuffer.isView(rawInput)) {
    return Buffer.from(rawInput.buffer, rawInput.byteOffset, rawInput.byteLength).toString('utf8');
  }
  return String(rawInput);
}

function hexBytes(text) {
  return [...Buffer.from(String(text ?? ''), 'utf8')]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
}

/**
 * Classify one terminal event for `mikuhost doctor --keyboard`.
 *
 * This never records typed content: printable input is reported as a count and
 * hex bytes only, so prompts and API keys cannot be reconstructed from a screenshot
 * or from this tool.
 */
export function describeKeyEvent(rawInput, input, key = {}) {
  const raw = toText(rawInput) ?? String(input ?? '');
  const normalized = String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, '');
  const bytes = hexBytes(raw);
  const base = { raw, bytes, inputLength: [...normalized].length };

  if (raw === '\u007f') {
    return { ...base, kind: 'backspace', label: 'BACKSPACE', detail: 'DEL 0x7f — treated as Backspace' };
  }
  if (raw === '\b') {
    return { ...base, kind: 'backspace', label: 'BACKSPACE', detail: 'BS 0x08 — treated as Backspace' };
  }
  if (/^\u001b+[\u007f\b]$/.test(raw)) {
    return { ...base, kind: 'backspace', label: 'BACKSPACE (meta)', detail: 'ESC + DEL/BS' };
  }
  for (const sequence of SEQUENCES) {
    if (sequence.pattern.test(raw)) {
      return { ...base, kind: sequence.kind, label: sequence.label, detail: sequence.detail };
    }
  }
  if (key.tab) return { ...base, kind: 'tab', label: 'TAB', detail: 'cursor completion' };
  if (key.return) return { ...base, kind: 'enter', label: 'ENTER', detail: 'submit prompt' };
  if (key.escape) return { ...base, kind: 'escape', label: 'ESCAPE', detail: 'clear input / leave panel' };
  if (key.ctrl) {
    return { ...base, kind: 'ctrl', label: `CTRL+${String(input).toUpperCase() || '?'}`, detail: 'control chord' };
  }
  if (normalized) {
    return {
      ...base,
      kind: 'text',
      label: 'TEXT',
      detail: `${base.inputLength} character${base.inputLength === 1 ? '' : 's'} (content hidden)`,
      // Never hexdump printable content: a pasted prompt or API key must not be
      // reconstructable from the inspector screen.
      bytes: `hidden (${Buffer.byteLength(raw, 'utf8')} bytes)`,
    };
  }
  if (/^\u001b/.test(raw)) {
    return { ...base, kind: 'escape-sequence', label: 'UNKNOWN ESCAPE', detail: 'sequence not recognized' };
  }
  return { ...base, kind: 'unknown', label: 'UNKNOWN', detail: 'no normalized key was produced' };
}

function EventRow({ event, width }) {
  const color =
    event.kind === 'backspace' || event.kind === 'delete'
      ? theme.green
      : event.kind === 'unknown' || event.kind === 'escape-sequence'
        ? theme.yellow
        : theme.text;
  return h(
    Box,
    { flexDirection: 'column', marginBottom: 1 },
    h(
      Box,
      { width },
      h(Text, { color, bold: true }, event.label.padEnd(20)),
      h(Text, { color: theme.dim, wrap: 'truncate' }, event.detail),
    ),
    h(Text, { color: theme.faint, wrap: 'truncate' }, `bytes ${event.bytes || '(none)'}`),
  );
}

export function KeyboardInspector({ version }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rawInputRef = useRawInput();
  const [events, setEvents] = useState([]);
  const [size, setSize] = useState({ columns: stdout?.columns || 80, rows: stdout?.rows || 24 });
  const countRef = useRef(0);

  useEffect(() => {
    if (!stdout) return undefined;
    const update = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on('resize', update);
    return () => stdout.off?.('resize', update);
  }, [stdout]);

  useInput((input, key) => {
    const rawInput = rawInputRef.current;
    rawInputRef.current = null;
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    const described = describeKeyEvent(rawInput, input, key);
    countRef.current += 1;
    setEvents((previous) => [{ ...described, id: countRef.current }, ...previous].slice(0, 8));
  });

  const columns = Math.max(40, size.columns);
  return h(
    Box,
    { flexDirection: 'column', width: columns, paddingX: 1 },
    h(
      Box,
      { borderStyle: 'round', borderColor: theme.accent, flexDirection: 'column', paddingX: 1 },
      h(Text, { color: theme.accent, bold: true }, 'MIKUHOST KEYBOARD INSPECTOR'),
      h(Text, { color: theme.dim }, `raw terminal bytes · MikuHost ${version ?? ''}`.trim()),
    ),
    h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      h(Text, { color: theme.text }, `stdin TTY: ${process.stdin.isTTY ? 'yes' : 'no'}   stdout TTY: ${process.stdout.isTTY ? 'yes' : 'no'}   raw mode: ${process.stdin.isRaw ? 'on' : 'off'}`),
      h(Text, { color: theme.text }, `TERM=${process.env.TERM ?? 'unset'}   size=${size.columns}x${size.rows}   platform=${process.platform}`),
      h(
        Text,
        { color: theme.dim },
        'Android/Termux commonly sends 0x7f for Backspace; MikuHost treats both 0x7f and 0x08 as Backspace.',
      ),
    ),
    h(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      h(Text, { color: theme.yellow, bold: true }, 'Press keys to inspect them. Ctrl+C exits.'),
      h(Text, { color: theme.faint }, 'Content is never printed: text is shown only as a byte count.'),
    ),
    h(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      events.length === 0
        ? h(Text, { color: theme.faint }, 'Waiting for a key…')
        : events.map((event) => h(EventRow, { key: `event-${event.id}`, event, width: columns - 6 })),
    ),
  );
}

export function runKeyboardInspector({ version = null, stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!stdin.isTTY || !stdout.isTTY) {
    stdout.write('MIKUHOST KEYBOARD DIAGNOSTIC\n\n');
    stdout.write(`stdin isTTY: ${Boolean(stdin.isTTY)}\n`);
    stdout.write(`stdout isTTY: ${Boolean(stdout.isTTY)}\n`);
    stdout.write(`TERM: ${process.env.TERM ?? '(unset)'}\n`);
    stdout.write(`Platform: ${process.platform} ${process.arch}\n\n`);
    stdout.write('The raw keyboard inspector needs an interactive terminal.\n');
    stdout.write('Open mikuhost from a real terminal (or an SSH session with a PTY) and run:\n');
    stdout.write('  mikuhost doctor --keyboard\n');
    return 1;
  }
  const app = render(h(KeyboardInspector, { version }), { exitOnCtrlC: false });
  return app.waitUntilExit().then(() => 0);
}
