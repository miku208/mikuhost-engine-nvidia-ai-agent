import { Box, Text } from 'ink';
import { h } from '../h.mjs';
import { theme } from '../theme.mjs';
import { formatDuration } from '../../util/text.mjs';
import { PHASES } from '../../core/events.mjs';

const LABELS = {
  [PHASES.CONNECTING]: 'Connecting to NVIDIA',
  [PHASES.THINKING]: 'Thinking',
  [PHASES.TOOL_EXECUTION]: 'Working',
  [PHASES.WAITING_APPROVAL]: 'Waiting for approval',
  [PHASES.STREAMING]: 'Typing',
  [PHASES.CANCELLED]: 'Cancelled',
  [PHASES.COMPLETED]: 'Completed',
  [PHASES.ERROR]: 'Error',
};

const SHORT_LABELS = {
  [PHASES.CONNECTING]: 'CONNECTING',
  [PHASES.THINKING]: 'THINKING',
  [PHASES.TOOL_EXECUTION]: 'WORKING',
  [PHASES.WAITING_APPROVAL]: 'APPROVAL',
  [PHASES.STREAMING]: 'TYPING',
  [PHASES.CANCELLED]: 'CANCELLED',
  [PHASES.COMPLETED]: 'DONE',
  [PHASES.ERROR]: 'ERROR',
};

export function phaseLabel(phase) {
  return LABELS[phase] ?? 'Working';
}

export function phaseStatusLabel(phase) {
  return SHORT_LABELS[phase] ?? 'ENGINE';
}

function activityIcon(activity, frame) {
  if (activity.kind !== 'tool') return { text: '·', color: theme.faint };
  if (activity.status === 'ok') return { text: '✓', color: theme.green };
  if (activity.status === 'fail') return { text: '✗', color: theme.red };
  return { text: frame, color: theme.accent };
}

export function ActivityEngine({ frame, elapsedMs, activities = [], width, phase, maxActivities = 3 }) {
  // The parent reserves exactly this many rows; never render more than that.
  const visible = activities.slice(-Math.max(1, maxActivities));
  return h(
    Box,
    { flexDirection: 'column', paddingX: 1, flexShrink: 0 },
    h(
      Box,
      {},
      h(Text, { color: theme.accent, bold: true }, `${frame} ${phaseLabel(phase)}`),
      h(Text, { color: theme.dim }, ` · ${formatDuration(elapsedMs)}`),
    ),
    ...visible.map((activity, index) => {
      const icon = activityIcon(activity, frame);
      const duration = activity.durationMs ? ` · ${formatDuration(activity.durationMs)}` : '';
      return h(
        Text,
        {
          key: `activity-${activity.id ?? index}`,
          color: index === visible.length - 1 ? theme.text : theme.dim,
          wrap: 'truncate',
        },
        `  ${icon.text} `,
        h(Text, { color: icon.color }, activity.text),
        h(Text, { color: theme.faint }, duration),
      );
    }),
  );
}
