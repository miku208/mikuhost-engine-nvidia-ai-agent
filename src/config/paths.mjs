// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * All MikuHost persistent state lives in a single config directory so that
 * permissions can be locked down (0700) in one place.
 *
 * Overriding via MIKUHOST_CONFIG_DIR is what the test-suite uses; it is also
 * handy for running an isolated instance on a shared box.
 */
export function configDir() {
  const override = process.env.MIKUHOST_CONFIG_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.config', 'mikuhost');
}

export const paths = {
  dir: configDir,
  config: () => path.join(configDir(), 'config.json'),
  credentials: () => path.join(configDir(), 'credentials.json'),
  sessions: () => path.join(configDir(), 'sessions.db'),
  sessionsFallback: () => path.join(configDir(), 'sessions.json'),
  // Pre-edit snapshots used by /undo (index + one file per snapshot).
  historyDir: () => path.join(configDir(), 'history'),
  historyIndex: () => path.join(configDir(), 'history', 'index.json'),
  logs: () => path.join(configDir(), 'logs'),
  logFile: () => path.join(configDir(), 'logs', 'mikuhost.log'),
};

export function ensureConfigDir() {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // chmod may fail on exotic filesystems; the directory is still created.
  }
  const logs = paths.logs();
  if (!fs.existsSync(logs)) {
    fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(logs, 0o700);
    } catch {
      /* ignore */
    }
  }
  return dir;
}
