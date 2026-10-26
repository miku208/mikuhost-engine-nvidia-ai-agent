/** Text helpers shared by the CLI, the TUI and the session store. */

/**
 * Mask a credential for display. Never reveals more than a short prefix and
 * the last four characters.
 */
export function maskKey(key) {
  if (typeof key !== 'string' || key.length === 0) return '(none)';
  const prefixMatch = /^(nvapi-|thk[_-]|sk-|key-)/i.exec(key);
  const prefix = prefixMatch ? prefixMatch[0] : '';
  const body = key.slice(prefix.length);
  const tail = body.length >= 8 ? body.slice(-4) : '';
  return `${prefix}${'•'.repeat(12)}${tail}`;
}

/** Mask a value as typed in a password field. */
export function maskTyped(value) {
  return '•'.repeat(String(value ?? '').length);
}

const SECRET_PATTERNS = [
  /\bnvapi-[A-Za-z0-9_-]{8,}\b/g,
  /\bthk[_-][A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(authorization\s*:\s*bearer\s+)[^\s]+/gi,
  /((?:api[_-]?key|token|secret|password)\s*[=:]\s*["']?)[^\s"',;]{8,}/gi,
];

/** Redact anything that looks like a credential. Used before persisting or logging. */
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, keep) => {
      if (typeof keep === 'string' && keep) return `${keep}[redacted]`;
      return '[redacted]';
    });
  }
  return out;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_PATTERN, '');
}

export function truncate(text, max, suffix = '…') {
  const str = String(text ?? '');
  if (str.length <= max) return str;
  if (max <= suffix.length) return str.slice(0, max);
  return str.slice(0, max - suffix.length) + suffix;
}

export function truncateMiddle(text, max) {
  const str = String(text ?? '');
  if (str.length <= max) return str;
  if (max < 12) return str.slice(0, max);
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${str.slice(0, head)}…${str.slice(str.length - tail)}`;
}

export function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatRelativeTime(timestamp, now = Date.now()) {
  if (!timestamp) return '';
  const diff = Math.max(0, now - Number(timestamp));
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d`;
  return new Date(Number(timestamp)).toLocaleDateString();
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** First line of a prompt, trimmed, used as an auto session title. */
export function titleFromPrompt(prompt) {
  const firstLine = String(prompt ?? '').trim().split(/\r?\n/)[0] ?? '';
  const cleaned = firstLine.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'New Session';
  return truncate(cleaned, 48);
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split text into lines without allocating huge arrays for enormous outputs. */
export function toLines(text, limit = 5000) {
  const str = String(text ?? '');
  const lines = str.split(/\r?\n/);
  if (lines.length <= limit) return lines;
  const trimmed = lines.slice(0, limit);
  trimmed.push(`… ${lines.length - limit} more lines omitted`);
  return trimmed;
}
