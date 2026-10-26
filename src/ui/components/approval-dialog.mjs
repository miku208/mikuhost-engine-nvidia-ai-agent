import { Box, Text } from 'ink';
import { h } from '../h.mjs';
import { theme } from '../theme.mjs';
import { wrapCommandLines } from '../text-layout.mjs';

function Field({ label, value, color = theme.text }) {
  return h(
    Box,
    {},
    h(Text, { color: theme.dim }, `${label.padEnd(10)} `),
    h(Text, { color, wrap: 'truncate' }, String(value)),
  );
}

/**
 * The command is the thing being approved, so it is shown in full (wrapped)
 * instead of truncated to one line: a cut-off command cannot be reviewed.
 */
function CommandBlock({ command, width, limit }) {
  const { lines, hidden } = wrapCommandLines(command, Math.max(20, width - 4), limit);
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { color: theme.dim }, 'Command:'),
    ...lines.map((line, index) =>
      h(Text, { key: `cmd-${index}`, color: theme.text, wrap: 'truncate' }, `  ${line}`),
    ),
    hidden ? h(Text, { color: theme.faint }, `  … ${hidden} more line(s) not shown`) : null,
  );
}

function diffNodes(diff, limit) {
  const lines = String(diff ?? '').split('\n');
  const nodes = lines.slice(0, limit).map((line, index) => {
    const color = line.startsWith('+')
      ? theme.green
      : line.startsWith('-')
        ? theme.red
        : line.startsWith('…')
          ? theme.faint
          : theme.dim;
    return h(Text, { key: `diff-${index}`, color, wrap: 'truncate' }, line || ' ');
  });
  if (lines.length > limit) {
    nodes.push(h(Text, { key: 'diff-more', color: theme.faint }, `… ${lines.length - limit} more diff lines`));
  }
  return nodes;
}

export function ApprovalDialog({ request, width, maxHeight = 24 }) {
  if (!request) return null;
  const isCommand = request.kind === 'command';
  const isRead = request.kind === 'file-read';
  const title = isCommand
    ? request.mode === 'allow'
      ? 'SHELL EXECUTION · ALWAYS ALLOW'
      : 'SHELL EXECUTION REQUEST'
    : isRead
      ? 'SENSITIVE FILE REQUEST'
      : request.kind === 'file-create'
        ? 'CREATE FILE REQUEST'
        : 'FILE CHANGE REQUEST';

  const reasons = (Array.isArray(request.reasons) ? request.reasons : request.reason ? [request.reason] : [])
    .filter((reason) => reason && reason !== 'read-only command' && reason !== 'no executable segment found');
  const riskColor = request.risk === 'critical' ? theme.red : request.risk === 'guarded' ? theme.yellow : theme.dim;
  const diffLimit = Math.max(3, Math.min(8, maxHeight - 9));
  const previewLimit = Math.max(2, Math.min(6, maxHeight - 10));
  const reasonLimit = Math.max(1, Math.min(2, maxHeight - 11));
  const commandLineLimit = Math.max(3, Math.min(10, maxHeight - 10));
  const dialogWidth = Math.min(width - 2, 100);
  const modeLabel =
    request.mode === 'auto' ? 'UNATTENDED' : request.mode === 'allow' ? 'ALWAYS ALLOW' : 'ALWAYS ASK';

  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: theme.yellow,
      paddingX: 1,
      width: dialogWidth,
      flexShrink: 0,
    },
    h(Text, { bold: true, color: theme.yellow }, title),
    isCommand
      ? h(CommandBlock, { command: request.command, width: dialogWidth, limit: commandLineLimit })
      : h(Field, { label: 'Target:', value: request.target, color: theme.text }),
    isCommand
      ? h(Field, { label: 'Directory:', value: request.cwd })
      : request.reason
        ? h(Field, { label: 'Reason:', value: request.reason })
        : null,
    isCommand
      ? h(Field, {
          label: 'Mode:',
          value: `${modeLabel} · ${request.riskLabel ?? request.risk ?? 'unknown'}`,
          color: riskColor,
        })
      : null,
    reasons.length
      ? h(
          Box,
          { flexDirection: 'column' },
          ...reasons.slice(0, reasonLimit).map((reason, index) =>
            h(Text, { key: `r-${index}`, color: riskColor, wrap: 'truncate' }, `· ${reason}`),
          ),
        )
      : null,
    isCommand && request.elevated && request.risk !== 'safe'
      ? h(Text, { color: theme.red, wrap: 'truncate' }, 'Agent runs as root — this affects the whole system.')
      : null,
    request.diff
      ? h(Box, { flexDirection: 'column', marginTop: 1 }, ...diffNodes(request.diff, diffLimit))
      : null,
    request.contentPreview
      ? h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          ...String(request.contentPreview)
            .split('\n')
            .slice(0, previewLimit)
            .map((line, index) => h(Text, { key: `c-${index}`, color: theme.text, wrap: 'truncate' }, `+ ${line}`)),
        )
      : null,
    h(
      Box,
      { marginTop: 1 },
      h(Text, { color: theme.green, bold: true }, '[A] Allow once'),
      h(Text, { color: theme.dim }, '   '),
      h(Text, { color: theme.red, bold: true }, '[D] Deny'),
      h(Text, { color: theme.dim }, '   '),
      h(Text, { color: theme.dim }, '[Esc] Cancel'),
    ),
  );
}
