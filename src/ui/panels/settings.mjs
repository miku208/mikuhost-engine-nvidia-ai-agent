// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import { Box, Text } from 'ink';
import { h } from '../h.mjs';
import { theme } from '../theme.mjs';
import { PanelFrame, PanelHint } from '../components/panel-frame.mjs';

const VALUES = ['ask', 'allow', 'auto'];

const SETTING_ROWS = [
  {
    key: 'shell',
    label: 'Shell execution',
    labels: { ask: '● Always Ask', allow: '● Always Allow', auto: '● Unattended' },
  },
  {
    key: 'fileWrite',
    label: 'File writes',
    labels: { ask: '● Ask', allow: '● Allow', auto: '● Unattended' },
  },
  {
    key: 'sensitiveRead',
    label: 'Sensitive file reads',
    labels: { ask: '● Ask', allow: '● Allow', auto: '● Unattended' },
  },
];

export const UNATTENDED_ROW = 'unattended';
export const SETTINGS_ROW_KEYS = [...SETTING_ROWS.map((row) => row.key), UNATTENDED_ROW];

/** True when every policy is auto: nothing is asked at all. */
export function isUnattended(permissions = {}) {
  return SETTING_ROWS.every((row) => permissions[row.key] === 'auto');
}

function valueOf(permissions, key) {
  const value = permissions?.[key];
  return VALUES.includes(value) ? value : 'ask';
}

export function SettingsPanel({ permissions, selected, width, rootWarning, confirming }) {
  const unattended = isUnattended(permissions);
  const unattendedIndex = SETTING_ROWS.length;
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
      const value = valueOf(permissions, row.key);
      return h(
        Box,
        { key: row.key, flexDirection: 'column', marginTop: index === 0 ? 1 : 0 },
        h(
          Box,
          {},
          h(Text, { color: selected === index ? theme.accent : theme.faint, bold: selected === index }, selected === index ? '❯ ' : '  '),
          h(Text, { color: theme.text }, row.label.padEnd(24)),
          h(Text, { color: value === 'ask' ? theme.green : theme.yellow, bold: selected === index }, row.labels[value]),
        ),
      );
    }),
    h(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      h(Text, { color: theme.dim }, 'UNATTENDED'),
      h(
        Box,
        {},
        h(
          Text,
          { color: selected === unattendedIndex ? theme.accent : theme.faint, bold: selected === unattendedIndex },
          selected === unattendedIndex ? '❯ ' : '  ',
        ),
        h(Text, { color: theme.text }, 'Leave the agent running'.padEnd(24)),
        h(
          Text,
          { color: unattended ? theme.yellow : theme.green, bold: selected === unattendedIndex },
          unattended ? '● On — nothing is asked' : '○ Off',
        ),
      ),
    ),
    h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      h(PanelHint, null, 'Always Ask: every shell command needs approval.'),
      h(PanelHint, null, 'Always Allow: read-only and project commands (tests/builds) run automatically; destructive, installer, network and opaque commands still ask.'),
      h(PanelHint, { color: theme.yellow }, 'Unattended: every tool call runs without asking — shell (including rm -rf, sudo, installers, network), file writes and sensitive reads — so a task can finish while you are away.'),
      h(PanelHint, { color: theme.faint }, 'Only use Unattended in a workspace you trust. It is not a sandbox: commands run with your OS user privileges, and the agent can read and write any file the workspace allows.'),
    ),
    rootWarning
      ? h(PanelHint, { color: theme.yellow }, 'Warning: the agent is running as root. Auto-executed commands inherit full system privileges. Prefer a limited OS user for real isolation.')
      : null,
    confirming
      ? confirming.key === 'all'
        ? h(
            Box,
            { flexDirection: 'column', marginTop: 1 },
            h(Text, { color: theme.red, bold: true }, 'Enable Unattended mode for every tool?'),
            h(Text, { color: theme.dim }, 'Shell commands (any risk), file writes and sensitive reads will run without approval.'),
            h(Text, { color: theme.dim }, '[Y] Enable   [N] Cancel'),
          )
        : h(
            Box,
            { flexDirection: 'column', marginTop: 1 },
            h(Text, { color: theme.yellow, bold: true }, confirming.value === 'auto' ? 'Make this policy Unattended?' : 'Enable Always Allow for shell commands?'),
            h(Text, { color: theme.dim }, confirming.value === 'auto' ? 'This policy will stop asking for approval entirely.' : 'Guarded and high-risk commands will still require explicit approval.'),
            h(Text, { color: theme.dim }, '[Y] Enable   [N] Cancel'),
          )
      : null,
  );
}
