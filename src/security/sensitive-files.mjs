import path from 'node:path';

/**
 * Files that commonly hold credentials or private key material. Reading them
 * requires explicit approval even when the file is inside the workspace.
 *
 * Templates (.env.example, .env.sample, ...) are intentionally NOT sensitive:
 * they are meant to be read and edited by an agent.
 */
const TEMPLATE_SUFFIXES = new Set(['example', 'sample', 'template', 'dist', 'defaults']);

const PRIVATE_KEY_NAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk']);

const SENSITIVE_BASENAMES = new Set([
  '.npmrc',
  '.netrc',
  '.pgpass',
  '.git-credentials',
  '.htpasswd',
  'credentials.json',
  'secrets.json',
  'auth.json',
  'service-account.json',
  'service_account.json',
]);

const SENSITIVE_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.ppk',
  '.asc',
  '.kdbx',
]);

export function classifySensitive(filePath) {
  const base = path.basename(String(filePath ?? ''));
  const lower = base.toLowerCase();
  const segments = String(filePath ?? '').split(/[\\/]+/);

  if (!base) return { sensitive: false, reason: null };

  if (PRIVATE_KEY_NAMES.has(lower)) {
    return { sensitive: true, reason: 'SSH private key' };
  }

  if (lower === '.env') return { sensitive: true, reason: 'environment file (may contain secrets)' };
  if (lower.startsWith('.env.')) {
    const suffix = lower.slice('.env.'.length);
    const parts = suffix.split('.');
    if (parts.every((part) => TEMPLATE_SUFFIXES.has(part))) {
      return { sensitive: false, reason: null };
    }
    return { sensitive: true, reason: 'environment file (may contain secrets)' };
  }

  if (SENSITIVE_BASENAMES.has(lower)) {
    return { sensitive: true, reason: 'credential or auth state file' };
  }

  const ext = path.extname(lower);
  if (SENSITIVE_EXTENSIONS.has(ext)) {
    return { sensitive: true, reason: `private key or certificate bundle (${ext})` };
  }

  if (segments.includes('.ssh') && !lower.endsWith('.pub')) {
    return { sensitive: true, reason: 'file inside an .ssh directory' };
  }
  if (segments.includes('.aws') && lower === 'credentials') {
    return { sensitive: true, reason: 'AWS credentials file' };
  }
  if (segments.includes('.gnupg')) {
    return { sensitive: true, reason: 'GnuPG key material' };
  }

  return { sensitive: false, reason: null };
}

export function isSensitive(filePath) {
  return classifySensitive(filePath).sensitive;
}

export const SENSITIVE_PATTERNS = Object.freeze([
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa',
  'id_ed25519',
  'credentials.json',
  'secrets.json',
]);

/**
 * Heuristic used by the shell policy: does an argument look like a path to
 * secret material? Used to force approval for `cat .env` and friends.
 */
export function looksLikeSecretReference(token) {
  if (typeof token !== 'string' || !token) return false;
  const cleaned = token.replace(/^[A-Za-z]+=/, '').replace(/^['"]|['"]$/g, '');
  const base = path.basename(cleaned);
  if (!base) return false;
  if (classifySensitive(cleaned).sensitive) return true;
  if (/^\.env(\.|$)/i.test(base)) return true;
  if (/\.(pem|key|p12|pfx)$/i.test(base)) return true;
  if (/^id_(rsa|ed25519|ecdsa|dsa)$/i.test(base)) return true;
  return false;
}
