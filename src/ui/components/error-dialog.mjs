import { Box, Text } from 'ink';
import { h } from '../h.mjs';
import { theme } from '../theme.mjs';

const TITLES = {
  auth: 'NVIDIA API ERROR · INVALID KEY',
  forbidden: 'NVIDIA API ERROR · ACCESS DENIED',
  rate_limit: 'NVIDIA API ERROR · RATE LIMIT',
  invalid_model: 'NVIDIA API ERROR · MODEL UNAVAILABLE',
  not_found: 'NVIDIA API ERROR · ENDPOINT NOT FOUND',
  server: 'NVIDIA API ERROR · SERVER ERROR',
  network: 'NVIDIA API ERROR · NETWORK',
  timeout: 'NVIDIA API ERROR · TIMEOUT',
  aborted: 'REQUEST CANCELLED',
  bad_request: 'NVIDIA API ERROR · BAD REQUEST',
  malformed_response: 'NVIDIA API ERROR · MALFORMED RESPONSE',
};

export function ErrorDialog({ error, width, canRetry, canChangeKey }) {
  if (!error) return null;
  const title = TITLES[error.code] ?? 'MIKUHOST ERROR';
  const retrySeconds = error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : null;

  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: theme.red,
      paddingX: 1,
      width: Math.min(width - 2, 100),
      flexShrink: 0,
    },
    h(Text, { bold: true, color: theme.red }, title),
    error.httpStatus ? h(Text, { color: theme.dim }, `Status: HTTP ${error.httpStatus}`) : null,
    h(Text, { color: theme.text, wrap: 'wrap' }, error.message ?? String(error)),
    retrySeconds
      ? h(Text, { color: theme.yellow }, `Retry after: ${retrySeconds}s (the agent will not retry automatically)`)
      : null,
    h(
      Box,
      { marginTop: 1 },
      canRetry ? h(Text, { color: theme.green, bold: true }, '[R] Retry') : null,
      canChangeKey ? h(Text, { color: theme.yellow, bold: true }, '   [K] Change key') : null,
      h(Text, { color: theme.dim }, '   [Esc] Close'),
    ),
  );
}
