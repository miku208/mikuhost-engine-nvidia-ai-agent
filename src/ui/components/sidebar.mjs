// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import { Box, Text } from 'ink';
import { h } from '../h.mjs';
import { theme } from '../theme.mjs';
import { truncate } from '../../util/text.mjs';

/**
 * A permanent rail beside the chat. It is part of the layout, not an overlay:
 * there is no key that opens or closes it. On narrow terminals the space is not
 * there at all, so the rail disappears instead of squeezing the transcript.
 */
export function sidebarWidth(columns) {
  const width = Number(columns) || 0;
  if (width >= 120) return 30;
  if (width >= 100) return 26;
  if (width >= 92) return 22;
  return 0;
}

function Section({ label }) {
  return h(Text, { color: theme.accent, bold: true, wrap: 'truncate' }, `▍${label}`);
}

function Value({ text, color = theme.text, dim = false, max = 24 }) {
  return h(Text, { color, dim, wrap: 'truncate' }, ` ${truncate(String(text ?? '—'), max)}`);
}

function ToolRow({ tool, max = 20 }) {
  const icon = tool.running ? '·' : tool.ok === false ? '✗' : '✓';
  const color = tool.running ? theme.accent : tool.ok === false ? theme.red : theme.green;
  const duration = tool.durationMs
    ? ` ${tool.durationMs < 1000 ? `${Math.max(1, Math.round(tool.durationMs))}ms` : `${Math.round(tool.durationMs / 1000)}s`}`
    : '';
  return h(
    Text,
    { wrap: 'truncate' },
    h(Text, { color }, ` ${icon} `),
    h(Text, { color: tool.running ? theme.text : theme.dim }, truncate(`${tool.name}${duration}`, max)),
  );
}

export function Sidebar({
  width = 26,
  height = 24,
  title = 'New Session',
  messageCount = 0,
  model = '—',
  provider = '—',
  workspace = '—',
  permission = 'ask',
  tokenTotal = 0,
  tools = [],
  maxTools = 6,
} = {}) {
  const visible = tools.slice(-Math.max(1, maxTools));
  const earlier = Math.max(0, tools.length - visible.length);
  // Border (1) plus paddingX (2) are not available for text.
  const inner = Math.max(8, width - 3);
  const toolNodes = visible.length
    ? visible.map((tool, index) => h(ToolRow, { key: `tool-${tool.id ?? index}`, tool, max: inner - 3 }))
    : [h(Value, { key: 'no-tools', text: 'nothing yet', max: inner, color: theme.faint, dim: true })];
  const sections = [
    h(Section, { key: 'session', label: 'SESSION' }),
    h(Value, { key: 'title', text: title, max: inner, color: theme.text, dim: false }),
    h(Value, { key: 'count', text: `${messageCount} message${messageCount === 1 ? '' : 's'}`, max: inner, color: theme.dim, dim: true }),
    h(Text, { key: 'gap-1' }, ' '),
    h(Section, { key: 'model', label: 'MODEL' }),
    h(Value, { key: 'model-name', text: model, max: inner }),
    h(Value, { key: 'provider', text: provider, max: inner, color: theme.dim, dim: true }),
    h(Text, { key: 'gap-2' }, ' '),
    h(Section, { key: 'workspace', label: 'WORKSPACE' }),
    h(Value, { key: 'workspace-path', text: workspace, max: inner, color: theme.dim, dim: true }),
    h(Value, { key: 'permission', text: `shell ${String(permission).toUpperCase()}`, max: inner, color: theme.dim, dim: true }),
    h(Text, { key: 'gap-3' }, ' '),
    h(Section, { key: 'tools', label: 'TOOLS' }),
    ...toolNodes,
    earlier ? h(Value, { key: 'earlier', text: `+${earlier} earlier`, max: inner, color: theme.faint, dim: true }) : null,
    h(Text, { key: 'gap-4' }, ' '),
    h(Section, { key: 'tokens', label: 'TOKENS' }),
    h(Value, { key: 'token-total', text: tokenTotal ? String(tokenTotal) : '—', max: inner, color: theme.dim, dim: true }),
  ].filter(Boolean);

  return h(
    Box,
    {
      width,
      height,
      flexShrink: 0,
      flexDirection: 'column',
      paddingX: 1,
      borderStyle: 'single',
      borderTop: false,
      borderBottom: false,
      borderLeft: false,
      borderRight: true,
      borderColor: theme.border,
      overflow: 'hidden',
    },
    ...sections,
  );
}
