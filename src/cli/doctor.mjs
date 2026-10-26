// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { paths, ensureConfigDir } from '../config/paths.mjs';
import { ConfigManager } from '../config/manager.mjs';
import { CredentialManager } from '../credentials/manager.mjs';
import { createProvider, credentialsFromEnv, providerName, resolveProviderId } from '../providers/catalog.mjs';
import { openSessionStore } from '../sessions/database.mjs';
import { resolveWorkspaceRoot, isAccessible, isRootUser, Workspace } from '../security/workspace.mjs';
import { formatBytes } from '../util/text.mjs';
import { color } from '../util/color.mjs';

const require = createRequire(import.meta.url);

function hasNodeSqlite() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (x INTEGER)');
    db.close();
    return true;
  } catch {
    return false;
  }
}

function npmVersion() {
  try {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync('npm', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (result.status === 0) return result.stdout.trim();
    return null;
  } catch {
    return null;
  }
}

function commandPath(name) {
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const directory of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch {
        // Keep looking.
      }
    }
  }
  return null;
}

function dirPermissions(dir) {
  try {
    const stat = fs.statSync(dir);
    return (stat.mode & 0o777).toString(8).padStart(3, '0');
  } catch {
    return null;
  }
}

export async function runDoctor({ cwd = process.cwd() } = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = major > 20 || (major === 20 && minor >= 0);
  add('Node.js', nodeOk ? 'ok' : 'fail', `v${process.versions.node} (requires >= 20)`);

  const npm = npmVersion();
  add('npm', npm ? 'ok' : 'warn', npm ? `v${npm}` : 'npm not found on PATH');

  const cli = commandPath('mikuhost');
  add(
    'CLI on PATH',
    cli ? 'ok' : 'warn',
    cli ?? 'not found — use `npx mikuhost`, or add the npm global bin directory to PATH',
  );

  const sqlite = hasNodeSqlite();
  add('SQLite (node:sqlite)', sqlite ? 'ok' : 'warn', sqlite ? 'built-in SQLite available' : 'unavailable — sessions will use the JSON fallback');

  let config = null;
  let configManager = null;
  try {
    ensureConfigDir();
    configManager = new ConfigManager();
    config = configManager.load();
    const dir = paths.dir();
    const mode = dirPermissions(dir);
    add('Config directory', mode === '700' ? 'ok' : 'warn', `${dir} (mode ${mode ?? 'unknown'})`);
    add('Config file', fs.existsSync(paths.config()) ? 'ok' : 'warn', fs.existsSync(paths.config()) ? 'readable' : 'not created yet');
  } catch (error) {
    config = new ConfigManager();
    add('Config directory', 'fail', error.message);
  }

  let credentials = null;
  let activeKey = null;
  let activeProvider = configManager?.providerId ?? 'nvidia';
  let baseUrl = configManager?.baseUrlFor(activeProvider) ?? '';
  try {
    credentials = new CredentialManager();
    const active = credentials.activeEntry();
    activeKey = active?.key ?? null;
    if (active) activeProvider = resolveProviderId(active.provider);
    baseUrl = active?.baseUrl || configManager?.baseUrlFor(activeProvider) || '';
    const mode = dirPermissions(paths.credentials());
    if (credentials.size === 0) {
      add(
        'API keys',
        'warn',
        'none stored — run `mikuhost` for the setup wizard, or export NVIDIA_API_KEY / TOKENHARBOR_API_KEY',
      );
    } else {
      add(
        'API keys',
        'ok',
        `${credentials.size} available · active: ${active ? `${active.name} (${'•'.repeat(6)})` : 'none'} · mode ${mode ?? 'unknown'}`,
      );
    }
    const fromEnv = credentialsFromEnv(process.env);
    add(
      'Tokens from env',
      fromEnv.length ? 'ok' : 'warn',
      fromEnv.length
        ? fromEnv.map((entry) => providerName(entry.provider)).join(', ')
        : 'none detected (NVIDIA_API_KEY, TOKENHARBOR_API_KEY, MIKUHOST_API_KEY)',
    );
  } catch (error) {
    add('API keys', 'fail', error.message);
  }

  add('Active provider', 'ok', `${providerName(activeProvider)} (${activeProvider})`);
  add('API base URL', baseUrl ? 'ok' : 'warn', baseUrl || 'not configured — set MIKUHOST_BASE_URL or providers.<id>.baseUrl');

  if (activeKey) {
    try {
      const provider = createProvider({
        provider: activeProvider,
        baseUrl,
        apiKey: activeKey,
        timeoutMs: 12_000,
      });
      const models = await provider.listModels({ signal: AbortSignal.timeout(12_000) });
      add('Provider connectivity', 'ok', `reachable · ${models.length} models visible to this key`);
    } catch (error) {
      if (error.code === 'network') add('Provider connectivity', 'fail', 'network unreachable or DNS failure');
      else if (error.code === 'auth' || error.code === 'forbidden') add('Provider connectivity', 'fail', `credential rejected (HTTP ${error.httpStatus})`);
      else add('Provider connectivity', 'warn', error.message.slice(0, 120));
    }
  } else {
    add('Provider connectivity', 'warn', 'skipped (no API key)');
  }

  let workspaceInfo = null;
  try {
    workspaceInfo = resolveWorkspaceRoot({
      explicit: null,
      saved: configManager?.workspaceSetting ?? null,
    });
    const workspace = new Workspace(workspaceInfo.root);
    add('Workspace', 'ok', `${workspace.root} (source: ${workspaceInfo.source})`);
    let writable = true;
    try {
      fs.accessSync(workspace.root, fs.constants.W_OK);
    } catch {
      writable = false;
    }
    add('Workspace permissions', writable ? 'ok' : 'warn', writable ? 'readable and writable' : 'read-only (writes will fail)');
    add('Current directory', isAccessible(cwd) ? 'ok' : 'warn', cwd);
  } catch (error) {
    add('Workspace', 'fail', error.message);
  }

  const shellMode = configManager?.permissionMode ?? 'ask';
  add(
    'Shell permission',
    shellMode === 'ask' ? 'ok' : 'warn',
    shellMode === 'ask'
      ? 'Always Ask (default)'
      : shellMode === 'auto'
        ? 'Unattended — every command, file write and sensitive read runs without approval'
        : 'Always Allow — guarded/high-risk commands still require approval',
  );
  add('Running as', isRootUser() ? 'warn' : 'ok', isRootUser() ? 'root — the agent has full OS privileges; use a limited user for stronger isolation' : `uid ${process.getuid?.() ?? 'n/a'}`);

  try {
    const store = openSessionStore();
    const sessions = store.listSessions(1000);
    add('Session database', 'ok', `${store.kind} · ${sessions.length} sessions · ${paths.sessions()}`);
    store.close();
  } catch (error) {
    add('Session database', 'fail', error.message);
  }

  const tty = process.stdout.isTTY;
  add(
    'Terminal',
    tty ? 'ok' : 'warn',
    `${tty ? 'interactive TTY' : 'not a TTY (interactive UI disabled)'} · ${process.stdout.columns ?? '?'}x${process.stdout.rows ?? '?'} · TERM=${process.env.TERM ?? 'unset'}`,
  );
  add('Platform', 'ok', `${os.platform()} ${os.release()} · ${os.arch()} · ${formatBytes(os.totalmem())} RAM`);

  const failed = checks.filter((check) => check.status === 'fail').length;
  return { checks, exitCode: failed > 0 ? 1 : 0 };
}

export function printDoctor(report) {
  const symbols = { ok: color.green('✓'), warn: color.yellow('!'), fail: color.red('✗') };
  const header = `${color.bold('MIKUHOST DOCTOR')}`;
  process.stdout.write(`${header}\n\n`);
  const width = Math.max(...report.checks.map((check) => check.name.length));
  for (const check of report.checks) {
    process.stdout.write(`${symbols[check.status]} ${check.name.padEnd(width)}  ${color.dim(check.detail)}\n`);
  }
  const failed = report.checks.filter((check) => check.status === 'fail').length;
  const warned = report.checks.filter((check) => check.status === 'warn').length;
  process.stdout.write(
    `\n${failed ? color.red('✗') : color.green('✓')} ${report.checks.length - failed - warned} ok · ${warned} warnings · ${failed} failures\n`,
  );
}
