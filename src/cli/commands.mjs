import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseKeySelector, USAGE } from './arguments.mjs';
import { runDoctor, printDoctor } from './doctor.mjs';
import { ConfigManager, ensureConfigDir } from '../config/manager.mjs';
import { CredentialManager } from '../credentials/manager.mjs';
import { validateKeyFormat } from '../credentials/storage.mjs';
import { NvidiaProvider } from '../providers/nvidia.mjs';
import { ModelRegistry } from '../models/registry.mjs';
import { openSessionStore } from '../sessions/database.mjs';
import { resolveWorkspaceRoot, Workspace, isRootUser } from '../security/workspace.mjs';
import { formatRelativeTime, maskKey } from '../util/text.mjs';
import { color } from '../util/color.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export function packageVersion() {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8'));
    return json.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printKeyList(manager) {
  if (manager.size === 0) {
    process.stdout.write(
      `${color.yellow('No NVIDIA API keys stored.')}\nRun ${color.bold('mikuhost')} to start the setup wizard, or ${color.bold('mikuhost keys add <name> <key>')}.\n`,
    );
    return;
  }
  process.stdout.write(`${color.bold('NVIDIA API KEYS')}\n\n`);
  for (const entry of manager.list()) {
    const marker = entry.active ? color.green('●') : color.dim('○');
    const status =
      entry.status === 'invalid'
        ? color.red('invalid')
        : entry.status === 'rate_limited'
          ? color.yellow('rate-limited')
          : entry.status === 'unverified'
            ? color.yellow('unverified')
            : color.green('ready');
    const used = entry.lastUsedAt ? `used ${formatRelativeTime(entry.lastUsedAt)} ago` : 'never used';
    process.stdout.write(
      `${marker} ${entry.name.padEnd(16)} ${entry.masked.padEnd(22)} ${status.padEnd(20)} ${color.dim(used)}\n`,
    );
  }
  process.stdout.write(`\n${color.dim('Manage keys interactively with /keys inside mikuhost.')}\n`);
}

async function testKey(manager, selector) {
  const entry = parseKeySelector(manager, selector);
  if (!entry) {
    process.stderr.write(`${color.red('Key not found.')} Use \`mikuhost keys\` to list keys.\n`);
    return 1;
  }
  const config = new ConfigManager();
  config.load();
  const provider = new NvidiaProvider({ baseUrl: config.baseUrl, apiKey: entry.key });
  process.stdout.write(`Testing ${entry.name} (${maskKey(entry.key)})…\n`);
  const result = await provider.validateKey(entry.key);
  if (result.valid) {
    manager.setStatus(entry.id, 'ready');
    process.stdout.write(`${color.green('✓')} Key is valid. ${result.models.length} models available.\n`);
    return 0;
  }
  if (result.offline) {
    process.stdout.write(`${color.yellow('!')} Network unreachable; key could not be verified.\n`);
    return 1;
  }
  if (result.inconclusive) {
    process.stdout.write(`${color.yellow('!')} Provider returned an unexpected error: ${result.error.message}\n`);
    return 1;
  }
  manager.setStatus(entry.id, 'invalid', result.error.message);
  process.stdout.write(`${color.red('✗')} ${result.error.message}\n`);
  return 1;
}

async function keysCommand(args) {
  const manager = new CredentialManager();
  const [sub, ...rest] = args;
  if (!sub || sub === 'list') {
    printKeyList(manager);
    return 0;
  }
  if (sub === 'add') {
    const [name, key] = rest;
    if (!name || !key) {
      process.stderr.write('Usage: mikuhost keys add <name> <key>\n');
      return 2;
    }
    const check = validateKeyFormat(key);
    if (!check.ok) {
      process.stderr.write(`${color.red(check.reason)}\n`);
      return 2;
    }
    if (check.warning) process.stderr.write(`${color.yellow(check.warning)}\n`);
    try {
      const added = manager.add({ name, key });
      process.stdout.write(`${color.green('✓')} Added ${added.name} (${added.masked}).\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`${color.red(error.message)}\n`);
      return 1;
    }
  }
  if (sub === 'remove' || sub === 'delete') {
    const selector = rest[0];
    const entry = parseKeySelector(manager, selector);
    if (!entry) {
      process.stderr.write('Key not found. Usage: mikuhost keys remove <id|name>\n');
      return 1;
    }
    manager.remove(entry.id);
    process.stdout.write(`${color.green('✓')} Removed ${entry.name}.\n`);
    return 0;
  }
  if (sub === 'rename') {
    const [selector, ...nameParts] = rest;
    const name = nameParts.join(' ').trim();
    const entry = parseKeySelector(manager, selector);
    if (!entry || !name) {
      process.stderr.write('Usage: mikuhost keys rename <id|name> <new name>\n');
      return 2;
    }
    const updated = manager.rename(entry.id, name);
    process.stdout.write(`${color.green('✓')} Renamed to ${updated.name}.\n`);
    return 0;
  }
  if (sub === 'use' || sub === 'switch') {
    const entry = parseKeySelector(manager, rest[0]);
    if (!entry) {
      process.stderr.write('Key not found. Usage: mikuhost keys use <id|name>\n');
      return 1;
    }
    manager.setActive(entry.id);
    process.stdout.write(`${color.green('✓')} Active key: ${entry.name} (${maskKey(entry.key)}).\n`);
    return 0;
  }
  if (sub === 'test') {
    return testKey(manager, rest[0]);
  }
  process.stderr.write(`Unknown keys command: ${sub}\n`);
  return 2;
}

function modelsCommand(options = {}) {
  const config = new ConfigManager();
  config.load();
  const activeModel = options.model || config.get().defaultModel;
  const registry = new ModelRegistry({
    userModels: config.get().models,
    defaultModel: activeModel,
  });
  process.stdout.write(`${color.bold('MODELS')}\n\n`);
  registry.list().forEach((model, index) => {
    const active = model.id === activeModel;
    const marker = active ? color.green('●') : color.dim('○');
    const caps = [
      model.capabilities.tools === null ? 'tools unverified' : model.capabilities.tools ? 'tools' : 'no tools',
      model.capabilities.vision === null ? 'vision unverified' : model.capabilities.vision ? 'vision' : 'no vision',
      model.capabilities.contextWindow ? `${model.capabilities.contextWindow} ctx` : 'ctx unknown',
    ].join(' · ');
    process.stdout.write(`${marker} ${String(index + 1).padStart(2)}. ${model.name}\n`);
    process.stdout.write(`    ${color.dim(model.id)}\n`);
    process.stdout.write(`    ${color.dim(caps)}\n`);
  });
  process.stdout.write(
    `\n${color.dim('Model ids can be edited in config.json → "models". Availability is unverified until the provider catalogue is checked.')}\n`,
  );
  return 0;
}

function sessionsCommand() {
  const store = openSessionStore();
  const sessions = store.listSessions(30);
  store.close();
  if (!sessions.length) {
    process.stdout.write('No saved sessions yet.\n');
    return 0;
  }
  process.stdout.write(`${color.bold('SESSIONS')}\n\n`);
  for (const session of sessions) {
    process.stdout.write(
      `● ${session.title.slice(0, 44).padEnd(46)} ${color.dim(`${formatRelativeTime(session.updatedAt)} · ${session.model ?? 'no model'} · ${session.messageCount ?? '?'} messages`)}\n`,
    );
  }
  return 0;
}

function resolveStartupWorkspace(config, explicit) {
  if (explicit) {
    return new Workspace(explicit);
  }
  const resolved = resolveWorkspaceRoot({ saved: config.workspaceSetting || null });
  return new Workspace(resolved.root);
}

async function launchInteractive(options, { cwd }) {
  const config = new ConfigManager();
  config.load();
  let workspace;
  try {
    workspace = resolveStartupWorkspace(config, options.workspace);
  } catch (error) {
    process.stderr.write(`${color.red('Workspace error:')} ${error.message}\n`);
    return 1;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      `${color.yellow('The interactive UI needs a TTY.')}\n` +
        `Run mikuhost from a real terminal, or use:\n` +
        `  ${color.bold('mikuhost doctor')}    environment diagnostics\n` +
        `  ${color.bold('mikuhost keys')}      manage API keys\n` +
        `  ${color.bold('mikuhost models')}    list models\n`,
    );
    return 1;
  }
  process.env.MIKUHOST_INVOKED_CWD = cwd;

  let initialModel = null;
  if (options.model) {
    const registry = new ModelRegistry({ userModels: config.get().models, defaultModel: config.get().defaultModel });
    try {
      initialModel = registry.resolve(options.model);
      config.setValue('defaultModel', initialModel.id);
    } catch (error) {
      process.stderr.write(`${color.red('Model error:')} ${error.message}\n`);
      return 1;
    }
  }

  const { launchTui } = await import('../ui/app.mjs');
  return launchTui({
    config,
    workspace,
    initialModel: initialModel?.id ?? null,
    version: packageVersion(),
    restore: Boolean(options.resume),
    sessionId: options.session ?? null,
  });
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  const parsed = parseArgs(argv);
  try {
    ensureConfigDir();
  } catch {
    /* read-only or unusual filesystems: commands will report their own errors */
  }
  if (parsed.options['no-color']) {
    process.env.NO_COLOR = '1';
  }
  if (parsed.errors.length) {
    for (const error of parsed.errors) process.stderr.write(`${color.red('Error:')} ${error}\n`);
    process.stderr.write(`\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  switch (parsed.command) {
    case 'doctor': {
      if (parsed.options.keyboard) {
        const { runKeyboardInspector } = await import('../ui/keyboard-inspector.mjs');
        return runKeyboardInspector({ version: packageVersion() });
      }
      const report = await runDoctor({ cwd });
      printDoctor(report);
      return report.exitCode;
    }
    case 'keys':
      return keysCommand(parsed.args);
    case 'models':
      return modelsCommand(parsed.options);
    case 'sessions':
      return sessionsCommand();
    case null:
      return launchInteractive(parsed.options, { cwd });
    default:
      process.stderr.write(`Unknown command: ${parsed.command}\n`);
      return 2;
  }
}

export { USAGE, isRootUser };
