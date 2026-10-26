import { Box, Text } from 'ink';
import { h } from '../h.mjs';
import { theme, SYMBOLS } from '../theme.mjs';

function InfoRow({ label, value, color = theme.text }) {
  return h(
    Box,
    { paddingX: 1, flexGrow: 1, flexBasis: 0 },
    h(Text, { color: theme.dim }, label.padEnd(11)),
    h(Text, { color, wrap: 'truncate' }, value),
  );
}

export function Header({ model, workspace, session, status, statusColor, compact, width, provider = 'Provider' }) {
  const dot = SYMBOLS.bullet;
  const twoColumns = width >= 80;

  return h(
    Box,
    { flexDirection: 'column', flexShrink: 0 },
    h(
      Box,
      { borderStyle: 'round', borderColor: theme.border, paddingX: 1, flexDirection: 'column' },
      h(
        Box,
        { justifyContent: 'space-between' },
        h(Text, { bold: true, color: theme.accent }, 'MIKUHOST AGENT'),
        h(Text, { color: statusColor ?? theme.green }, `${dot} ${status}`),
      ),
      compact ? null : h(Text, { color: theme.dim }, 'Multi-Model AI Coding Assistant'),
    ),
    compact
      ? h(
          Box,
          { paddingX: 1 },
          h(Text, { color: theme.dim, wrap: 'truncate' }, `${model}  ·  ${workspace}  ·  ${session}`),
        )
      : twoColumns
        ? h(
            Box,
            { flexDirection: 'column' },
            h(
              Box,
              {},
              h(InfoRow, { label: 'Model', value: model, color: theme.green }),
              h(InfoRow, { label: 'Session', value: session }),
            ),
            h(
              Box,
              {},
              h(InfoRow, { label: 'Workspace', value: workspace }),
              h(InfoRow, { label: 'Provider', value: provider }),
            ),
          )
        : h(
            Box,
            { flexDirection: 'column' },
            h(InfoRow, { label: 'Model', value: model, color: theme.green }),
            h(InfoRow, { label: 'Workspace', value: workspace }),
            h(InfoRow, { label: 'Session', value: session }),
            h(InfoRow, { label: 'Provider', value: provider }),
          ),
    h(Text, { color: theme.border }, '─'.repeat(Math.max(10, width))),
  );
}

export function headerHeight({ compact, width }) {
  const twoColumns = width >= 80;
  return (compact ? 3 : 4) + (compact ? 1 : twoColumns ? 2 : 4) + 1;
}
