// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import { Box, Text } from 'ink';
import { h } from '../h.mjs';
import { theme } from '../theme.mjs';

const TITLES = {
  auth: 'PROVIDER ERROR · INVALID KEY',
  forbidden: 'PROVIDER ERROR · ACCESS DENIED',
  account: 'PROVIDER ERROR · ACCOUNT ACTION REQUIRED',
  rate_limit: 'PROVIDER ERROR · RATE LIMIT',
  invalid_model: 'PROVIDER ERROR · MODEL UNAVAILABLE',
  not_found: 'PROVIDER ERROR · ENDPOINT NOT FOUND',
  server: 'PROVIDER ERROR · SERVER ERROR',
  network: 'PROVIDER ERROR · NETWORK',
  timeout: 'PROVIDER ERROR · TIMEOUT',
  aborted: 'REQUEST CANCELLED',
  bad_request: 'PROVIDER ERROR · BAD REQUEST',
  malformed_response: 'PROVIDER ERROR · MALFORMED RESPONSE',
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
