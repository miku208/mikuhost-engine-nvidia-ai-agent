// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import { redactSecrets } from '../util/text.mjs';

export class ProviderError extends Error {
  constructor(message, options = {}) {
    super(redactSecrets(message));
    this.name = 'ProviderError';
    this.code = options.code ?? 'unknown';
    this.httpStatus = options.httpStatus ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.detail = options.detail ? redactSecrets(String(options.detail).slice(0, 1200)) : null;
    this.retriable = Boolean(options.retriable);
  }
}

export const ERROR_CODES = Object.freeze({
  AUTH: 'auth',
  FORBIDDEN: 'forbidden',
  ACCOUNT: 'account',
  NOT_FOUND: 'not_found',
  INVALID_MODEL: 'invalid_model',
  RATE_LIMIT: 'rate_limit',
  SERVER: 'server',
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  ABORTED: 'aborted',
  BAD_REQUEST: 'bad_request',
  MALFORMED: 'malformed_response',
  UNKNOWN: 'unknown',
});

/** Parse Retry-After (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Math.round(Number(text) * 1000));
  const date = Date.parse(text);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

export function extractErrorMessage(bodyText) {
  if (!bodyText) return '';
  try {
    const parsed = JSON.parse(bodyText);
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? parsed?.error;
    if (typeof message === 'string') return message;
    if (message && typeof message === 'object') return JSON.stringify(message).slice(0, 500);
  } catch {
    /* not JSON */
  }
  return String(bodyText).slice(0, 500);
}

/**
 * Machine code a gateway put in the error body (`error.code` / `error.type`).
 * TokenHarbor answers a blocked account with 403 + `email_verification_required`,
 * which means the key itself authenticated; that must not read as "invalid key".
 */
export function providerErrorCode(bodyText) {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);
    const raw =
      parsed?.error?.code ?? parsed?.error?.type ?? parsed?.code ?? parsed?.type ?? null;
    return typeof raw === 'string' ? raw.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

const ACCOUNT_CODE = /(email[_-]?verification[_-]?required|verification[_-]?required|email[_-]?not[_-]?verified|account[_-]?(blocked|suspended|disabled))/;
const ACCOUNT_MESSAGE = /(verify your email|email (address )?(is )?not verified|confirm your email|account (has been )?(suspended|disabled|blocked))/i;

export function classifyHttpError(status, bodyText, headers) {
  const detail = extractErrorMessage(bodyText);
  const lower = detail.toLowerCase();
  const retryAfterMs = parseRetryAfter(headers?.get?.('retry-after'));
  const bodyCode = providerErrorCode(bodyText);

  if (status === 401) {
    return new ProviderError('Invalid API key (HTTP 401).', {
      code: ERROR_CODES.AUTH,
      httpStatus: status,
      detail,
    });
  }
  if (status === 403) {
    // The credential was recognised — the account behind it is what is blocked.
    // Pass the provider's own instructions (it links to the dashboard) so the
    // user can fix the account instead of replacing a perfectly good key.
    if (ACCOUNT_CODE.test(bodyCode ?? '') || ACCOUNT_MESSAGE.test(detail)) {
      return new ProviderError(
        detail || 'The provider blocked this key\'s account. Verify it in the provider dashboard, then test the key again.',
        {
          code: ERROR_CODES.ACCOUNT,
          httpStatus: status,
          detail,
        },
      );
    }
    return new ProviderError(
      `Access denied by the provider (HTTP 403). The key was accepted, but this account or key cannot use this model.${detail ? ` ${detail}` : ''}`,
      {
        code: ERROR_CODES.FORBIDDEN,
        httpStatus: status,
        detail,
      },
    );
  }
  if (status === 404) {
    if (/model/.test(lower)) {
      return new ProviderError(`Model unavailable for this credential: ${detail || 'not found'}`, {
        code: ERROR_CODES.INVALID_MODEL,
        httpStatus: status,
        detail,
      });
    }
    return new ProviderError('Endpoint not found (HTTP 404). Check the configured base URL.', {
      code: ERROR_CODES.NOT_FOUND,
      httpStatus: status,
      detail,
    });
  }
  if (status === 429) {
    const retryText = retryAfterMs !== null ? ` Retry after ${Math.ceil(retryAfterMs / 1000)}s.` : '';
    return new ProviderError(`Rate limit reached (HTTP 429).${retryText}`, {
      code: ERROR_CODES.RATE_LIMIT,
      httpStatus: status,
      retryAfterMs,
      detail,
    });
  }
  if (status === 400 || status === 422) {
    if (/model/.test(lower) && /(not found|unknown|unavailable|does not exist|invalid)/.test(lower)) {
      return new ProviderError(`Model unavailable for this credential: ${detail}`, {
        code: ERROR_CODES.INVALID_MODEL,
        httpStatus: status,
        detail,
      });
    }
    return new ProviderError(`Request rejected by the provider (HTTP ${status}).${detail ? ` ${detail}` : ''}`, {
      code: ERROR_CODES.BAD_REQUEST,
      httpStatus: status,
      detail,
    });
  }
  if (status >= 500) {
    return new ProviderError(`Provider server error (HTTP ${status}).`, {
      code: ERROR_CODES.SERVER,
      httpStatus: status,
      retryAfterMs,
      detail,
      retriable: true,
    });
  }
  return new ProviderError(`Unexpected provider response (HTTP ${status}).`, {
    code: ERROR_CODES.UNKNOWN,
    httpStatus: status,
    detail,
  });
}

export function classifyFetchError(error, { timedOut = false } = {}) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return new ProviderError(timedOut ? 'Request timed out.' : 'Request cancelled.', {
      code: timedOut ? ERROR_CODES.TIMEOUT : ERROR_CODES.ABORTED,
      retriable: false,
    });
  }
  const cause = error?.cause?.code || error?.cause?.message || error?.message || String(error);
  return new ProviderError(`Network error contacting the provider: ${redactSecrets(String(cause))}`, {
    code: ERROR_CODES.NETWORK,
    detail: redactSecrets(String(cause)),
    retriable: true,
  });
}

/** Human friendly one-liner for the error dialog / status bar. */
export function describeProviderError(error) {
  if (!error) return 'Unknown error';
  if (error.code === ERROR_CODES.RATE_LIMIT) {
    const seconds = error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : null;
    return seconds ? `Rate limit — retry after ${seconds}s` : 'Rate limit reached';
  }
  if (error.code === ERROR_CODES.AUTH) return 'Invalid API key';
  if (error.code === ERROR_CODES.ACCOUNT) return 'Account action required';
  if (error.code === ERROR_CODES.INVALID_MODEL) return 'Model unavailable for this credential';
  if (error.code === ERROR_CODES.NETWORK) return 'Network unreachable';
  if (error.code === ERROR_CODES.TIMEOUT) return 'Request timed out';
  if (error.code === ERROR_CODES.ABORTED) return 'Cancelled';
  return error.message;
}
