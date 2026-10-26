import { Box, Text } from 'ink';
import { h } from '../h.mjs';
import { theme } from '../theme.mjs';

export function PanelFrame({ title, subtitle = null, width, children, footer = null }) {
  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: theme.borderActive,
      paddingX: 1,
      flexGrow: 1,
      width,
    },
    h(
      Box,
      { justifyContent: 'space-between', flexShrink: 0 },
      h(Text, { color: theme.accent, bold: true }, title),
      subtitle ? h(Text, { color: theme.dim }, subtitle) : null,
    ),
    h(Box, { flexDirection: 'column', flexGrow: 1, marginTop: 1 }, children),
    footer ? h(Text, { color: theme.faint, wrap: 'truncate' }, footer) : null,
  );
}

export function PanelRow({ selected = false, marker = null, label, detail = null, labelColor = theme.text, detailColor = theme.dim }) {
  return h(
    Box,
    { justifyContent: 'space-between', flexShrink: 0 },
    h(
      Box,
      { flexShrink: 1 },
      h(Text, { color: selected ? theme.accent : theme.faint, bold: selected }, selected ? '❯ ' : '  '),
      marker ? h(Text, { color: marker.color ?? theme.dim }, `${marker.text} `) : null,
      h(Text, { color: selected ? theme.text : labelColor, wrap: 'truncate' }, label),
    ),
    detail ? h(Text, { color: detailColor, wrap: 'truncate' }, String(detail)) : null,
  );
}

export function PanelHint({ children, color = theme.dim }) {
  return h(Text, { color, wrap: 'wrap' }, children);
}

export function PanelPrompt({ label, value, masked = false, cursor = null, hint = null }) {
  const shown = masked ? '•'.repeat(String(value ?? '').length) : String(value ?? '');
  const hasCursor = Number.isInteger(cursor);
  return h(
    Box,
    { marginTop: 1, flexDirection: 'column', flexShrink: 0 },
    h(Text, { color: theme.accent, bold: true }, label),
    h(
      Box,
      {},
      h(Text, { color: theme.yellow }, '> '),
      h(Text, { color: theme.text }, hasCursor ? shown.slice(0, cursor) : shown),
      hasCursor ? h(Text, { backgroundColor: theme.accent, color: '#0d1117' }, shown.slice(cursor, cursor + 1) || ' ') : null,
      hasCursor ? h(Text, { color: theme.text }, shown.slice(cursor + 1)) : null,
    ),
    hint ? h(Text, { color: theme.faint, wrap: 'wrap' }, hint) : null,
    h(Text, { color: theme.faint }, '[Enter] Confirm   [Esc] Cancel'),
  );
}

export function EmptyState({ text }) {
  return h(Text, { color: theme.dim }, text);
}
