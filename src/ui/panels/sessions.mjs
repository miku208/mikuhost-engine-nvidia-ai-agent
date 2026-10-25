import { Box, Text } from 'ink';
import { h } from '../h.mjs';
import { theme } from '../theme.mjs';
import { PanelFrame, PanelRow, PanelHint } from '../components/panel-frame.mjs';
import { formatRelativeTime } from '../../util/text.mjs';

export function SessionsPanel({ sessions, selected, currentId, width, confirming }) {
  return h(
    PanelFrame,
    {
      title: 'SESSIONS',
      subtitle: `${sessions.length} saved`,
      width,
      footer: '[N] New   [D] Delete   [Enter] Open   [Esc] Close',
    },
    sessions.length === 0
      ? h(PanelHint, null, 'No sessions yet. Press N to start one.')
      : sessions.map((session, index) =>
          h(PanelRow, {
            key: session.id,
            selected: index === selected,
            marker: { text: session.id === currentId ? '●' : '○', color: session.id === currentId ? theme.green : theme.faint },
            label: session.title,
            detail: `${formatRelativeTime(session.updatedAt)} · ${session.messageCount ?? 0} msg`,
            labelColor: theme.text,
          }),
        ),
    confirming
      ? h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          h(Text, { color: theme.red, bold: true }, `Delete "${confirming.title}"? This cannot be undone.`),
          h(Text, { color: theme.dim }, '[Y] Delete   [N] Cancel'),
        )
      : null,
  );
}
