import { Box, Text } from 'ink';
import { h } from '../h.mjs';
import { theme } from '../theme.mjs';
import { PanelFrame, PanelRow, PanelHint, PanelPrompt, EmptyState } from '../components/panel-frame.mjs';
import { formatRelativeTime } from '../../util/text.mjs';

const STATUS_COLORS = {
  ready: theme.green,
  invalid: theme.red,
  rate_limited: theme.yellow,
  unverified: theme.yellow,
};

const STATUS_LABELS = {
  ready: 'READY',
  invalid: 'INVALID',
  rate_limited: 'RATE LIMITED',
  unverified: 'UNVERIFIED',
};

export function KeysPanel({ keys, selected, width, prompt, testMessage, confirming }) {
  const active = keys.find((entry) => entry.active);
  return h(
    PanelFrame,
    {
      title: 'API KEY MANAGER',
      subtitle: active ? `${keys.length} stored · ${active.name} active` : `${keys.length} stored`,
      width,
      footer: '[A] Add   [T] Test   [S] Switch   [R] Rename   [D] Delete   ↑↓ Navigate   Enter Select   Esc Back',
    },
    keys.length === 0
      ? h(EmptyState, { text: 'No keys stored. Press A to add one.' })
      : keys.map((entry, index) => {
          const status = STATUS_LABELS[entry.status] ?? 'UNVERIFIED';
          const badge = entry.active && entry.status === 'ready' ? 'ACTIVE' : entry.active ? `ACTIVE · ${status}` : status;
          return h(PanelRow, {
            key: entry.id,
            selected: index === selected,
            marker: { text: entry.active ? '●' : '○', color: entry.active ? theme.green : theme.faint },
            label: entry.name,
            detail: `${entry.masked}  ${badge}${entry.lastUsedAt ? ` · ${formatRelativeTime(entry.lastUsedAt)}` : ''}`,
            detailColor: STATUS_COLORS[entry.status] ?? theme.dim,
          });
        }),
    prompt
      ? h(PanelPrompt, { label: prompt.label, value: prompt.value, masked: prompt.masked, cursor: prompt.cursor })
      : null,
    testMessage ? h(PanelHint, { color: theme.yellow }, testMessage) : null,
    confirming
      ? h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          h(Text, { color: theme.red, bold: true }, `Delete key "${confirming.name}"? [Y] Delete   [N] Cancel`),
        )
      : null,
    h(
      PanelHint,
      { color: theme.faint },
      'Enter or S switches the key used by the next request. Keys are stored with mode 0600 and only ever displayed masked.',
    ),
    h(
      PanelHint,
      { color: theme.faint },
      'The agent never rotates keys automatically on HTTP 429; Retry-After is respected and you can switch manually.',
    ),
  );
}
