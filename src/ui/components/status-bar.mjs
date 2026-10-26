// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import { Box, Text } from 'ink';
import { h } from '../h.mjs';
import { theme } from '../theme.mjs';
import { formatDuration } from '../../util/text.mjs';
import { phaseStatusLabel } from './activity.mjs';

export function StatusBar({
  model,
  workspace,
  provider = 'Provider',
  permission,
  busy,
  frame,
  elapsedMs,
  lastActivity,
  width,
  panel,
  compact,
  sessionTitle,
  tokenTotal,
  phase = null,
  tiny = false,
  newOutput = false,
  attachmentCount = 0,
  attachmentSelected = false,
  captureActive = false,
  pasteMarkers = null,
  divider = true,
}) {
  // Received markers are a fact; without one we only know that no bracketed
  // block has arrived yet, not that the terminal lacks support. `null` hides
  // the indicator (dialogs do not own the composer).
  const markerLabel = pasteMarkers ? 'bracketed ✓' : 'bracketed ?';
  const markerColor = pasteMarkers ? theme.green : theme.yellow;
  const permissionLabel = permission === 'allow' ? 'AUTO' : 'ASK';
  const permissionColor = permission === 'allow' ? theme.yellow : theme.dim;

  const left = busy
    ? `${frame} ${phaseStatusLabel(phase)} ${formatDuration(elapsedMs)}${lastActivity ? ` · ${lastActivity}` : ''}`
    : `${model} · ${workspace} · ${provider} · ${permissionLabel}`;
  const right = newOutput ? '↓ New output' : busy ? 'Ctrl+C cancel' : panel ? 'Esc close' : 'Ctrl+N new';

  const hints = (() => {
    if (panel) return '↑↓ Navigate   Enter Select   Esc Close';
    if (captureActive) return 'Paste capture · Ctrl+D attach · Enter newline · Esc cancel';
    if (attachmentSelected) return 'Esc remove selected   Tab next   Ctrl+X remove last';
    if (attachmentCount)
      return `${attachmentCount} pasted attachment${attachmentCount === 1 ? '' : 's'} · Tab select · Ctrl+X remove last · /attachments`;
    if (compact) return '← Sessions   → Models   /help';
    return '← Sessions   ↑↓ History   → Models   PgUp/PgDn Scroll   /help';
  })();

  return h(
    Box,
    { flexDirection: 'column', flexShrink: 0 },
    divider ? h(Text, { color: theme.border }, '─'.repeat(Math.max(10, width))) : null,
    h(
      Box,
      { justifyContent: 'space-between', paddingX: 1 },
      h(
        Text,
        { color: busy ? theme.accent : theme.dim, wrap: 'truncate' },
        `${left}${tokenTotal ? ` · ${tokenTotal} tok` : ''}`,
      ),
      h(
        Box,
        { flexShrink: 0 },
        pasteMarkers === null ? null : h(Text, { color: markerColor }, markerLabel),
        h(Text, { color: theme.faint, wrap: 'truncate' }, pasteMarkers === null ? right : `  ${right}`),
      ),
    ),
    tiny
      ? null
      : h(
          Box,
          { justifyContent: 'space-between', paddingX: 1 },
          h(Text, { color: theme.faint, wrap: 'truncate' }, hints),
          sessionTitle ? h(Text, { color: theme.faint, wrap: 'truncate' }, sessionTitle.slice(0, 28)) : null,
        ),
  );
}
