import { Box, Text } from 'ink';
import { h } from '../h.mjs';
import { theme } from '../theme.mjs';
import { buildComposerLayout, maxComposerLines, maxAttachmentRows, attachmentWindow } from '../composer-layout.mjs';
import { formatAttachmentCard } from '../../paste/attachments.mjs';

function AttachmentLine({ attachment, selected }) {
  const label = `  ${selected ? '▶ ' : ''}${formatAttachmentCard(attachment)}${selected ? '  Esc remove' : ''}`;
  return h(
    Text,
    {
      color: selected ? '#0d1117' : theme.blue,
      backgroundColor: selected ? theme.blue : undefined,
      bold: selected,
      wrap: 'truncate',
    },
    label,
  );
}

/**
 * One composer container owns the prompt text, the attachment chips and the
 * paste-capture hint. Chips are single-line labels inside the same box, never a
 * second panel below it.
 */
export function PromptInput({
  value,
  cursor,
  width,
  placeholder,
  disabled,
  busy,
  attachments = [],
  selectedAttachmentId = null,
  rows = 24,
  maxLines = null,
  captureActive = false,
}) {
  const layout = buildComposerLayout({
    value,
    cursor,
    width: Math.max(12, width - 4),
    maxLines: maxLines ?? maxComposerLines(rows),
  });
  const window = attachmentWindow(attachments, maxAttachmentRows(rows), selectedAttachmentId);
  const visibleAttachments = window.items;
  const hiddenAttachments = window.hidden;

  return h(
    Box,
    {
      flexDirection: 'column',
      flexShrink: 0,
      borderStyle: 'round',
      borderColor: disabled ? theme.faint : theme.border,
      paddingX: 1,
    },
    layout.lines.map((line, index) =>
      h(
        Box,
        { key: `composer-${index}` },
        h(Text, { color: disabled ? theme.faint : theme.accent, bold: true, wrap: 'truncate' }, index === 0 ? '❯ ' : '  '),
        line.isCursor
          ? h(
              Box,
              {},
              h(Text, { color: theme.user, wrap: 'truncate' }, line.before),
              h(Text, { backgroundColor: theme.accent, color: '#0d1117' }, line.at ?? ' '),
              h(Text, { color: theme.user, wrap: 'truncate' }, line.after),
              value.length === 0
                ? h(
                    Text,
                    { color: captureActive ? theme.yellow : theme.faint, wrap: 'truncate' },
                    ` ${busy ? 'Type while the agent works…' : placeholder ?? 'Ask MikuHost anything…'}`,
                  )
                : null,
            )
          : h(Text, { color: theme.user, wrap: 'truncate' }, line.before || ' '),
      ),
    ),
    ...visibleAttachments.map((attachment) =>
      h(Box, { key: attachment.id }, h(AttachmentLine, {
        attachment,
        selected: attachment.id === selectedAttachmentId,
      })),
    ),
    hiddenAttachments
      ? h(
          Text,
          { color: theme.faint },
          `  +${hiddenAttachments} more pasted attachment${hiddenAttachments === 1 ? '' : 's'} · Tab to select`,
        )
      : null,
  );
}
