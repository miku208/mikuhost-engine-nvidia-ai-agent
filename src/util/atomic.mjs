// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Atomic write: write to a sibling temp file, fsync, then rename over the
 * target. Rename within the same directory is atomic on POSIX, so a crash
 * mid-write can never leave a half-written credentials/config file.
 */
export function writeFileAtomic(file, data, options = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', options.mode ?? 0o600);
    if (options.mode !== undefined) {
      try {
        fs.fchmodSync(fd, options.mode);
      } catch {
        /* ignore */
      }
    }
    fs.writeFileSync(fd, data);
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync is best-effort (some filesystems / Termux) */
    }
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    if (options.mode !== undefined) {
      try {
        fs.chmodSync(file, options.mode);
      } catch {
        /* ignore */
      }
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export function writeJsonAtomic(file, value, options = {}) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, ...options });
}

export function readJson(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    return fallback;
  }
}

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function fileMode(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}
