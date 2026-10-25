import { Box, Text } from 'ink';
import { h } from '../h.mjs';
import { theme } from '../theme.mjs';
import { PanelFrame, PanelHint } from '../components/panel-frame.mjs';

const SETTING_ROWS = [
  { key: 'shell', label: 'Shell execution', options: ['ask', 'allow'] },
  { key: 'fileWrite', label: 'File writes', options: ['ask', 'allow'] },
  { key: 'sensitiveRead', label: 'Sensitive file reads', options: ['ask', 'allow'] },
];

export function SettingsPanel({ permissions, selected, width, rootWarning, confirming }) {
  return h(
    PanelFrame,
    {
      title: 'MIKUHOST SETTINGS',
      subtitle: 'shell & file permissions',
      width,
      footer: '↑↓ Navigate   [Enter] Toggle   [Esc] Back',
    },
    h(Text, { color: theme.dim }, 'SHELL EXECUTION'),
    ...SETTING_ROWS.map((row, index) => {
      const value = permissions[row.key] === 'allow' ? 'allow' : 'ask';
      const isShell = row.key === 'shell';
      return h(
        Box,
        { key: row.key, flexDirection: 'column', marginTop: index === 0 ? 1 : 0 },
        h(
          Box,
          {},
          h(Text, { color: selected === index ? theme.accent : theme.faint, bold: selected === index }, selected === index ? '❯ ' : '  '),
          h(Text, { color: selected === index ? theme.text : theme.text }, row.label.padEnd(24)),
          h(Text, { color: value === 'allow' ? theme.yellow : theme.green, bold: selected === index },
            isShell ? (value === 'allow' ? '● Always Allow' : '● Always Ask') : value === 'allow' ? '● Allow' : '● Ask'),
        ),
      );
    }),
    h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      h(PanelHint, null, 'Always Ask: every shell command needs approval.'),
      h(PanelHint, null, 'Always Allow: read-only and project commands (tests/builds) run automatically; destructive, installer, network and opaque commands still ask.'),
      h(PanelHint, { color: theme.faint }, 'File writes and sensitive reads have their own policy; Always Allow never bypasses credential-file protection.'),
    ),
    rootWarning
      ? h(PanelHint, { color: theme.yellow }, 'Warning: the agent is running as root. Auto-executed commands inherit full system privileges. Prefer a limited OS user for real isolation.')
      : null,
    confirming
      ? h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          h(Text, { color: theme.yellow, bold: true }, 'Enable Always Allow for shell commands?'),
          h(Text, { color: theme.dim }, 'Guarded and high-risk commands will still require explicit approval.'),
          h(Text, { color: theme.dim }, '[Y] Enable   [N] Cancel'),
        )
      : null,
  );
}
