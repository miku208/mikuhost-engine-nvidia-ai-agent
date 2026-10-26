import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseKeySelector, USAGE } from './arguments.mjs';
import { runDoctor, printDoctor } from './doctor.mjs';
import { ConfigManager, ensureConfigDir } from '../config/manager.mjs';
import { CredentialManager } from '../credentials/manager.mjs';
import { validateKeyFormat } from '../credentials/storage.mjs';
import {
  createProvider,
  detectedEnvProvider,
  envKeyNames,
  getProvider,
  providerIds,
  providerList,
  providerName,
  resolveProviderId,
} from '../providers/catalog.mjs';
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
      `${color.yellow('No API keys stored.')}\nRun ${color.bold('mikuhost')} to start the setup wizard, or ${color.bold('mikuhost keys add <name> <key>')}.\n` +
        `${color.dim(`Tokens in ${envKeyNames().join(', ')} are detected automatically.`)}\n`,
    );
    return;
  }
  process.stdout.write(`${color.bold('API KEYS')}\n\n`);
  for (const entry of manager.list()) {
    const marker = entry.active ? color.green('●') : color.dim('○');
    const status =
      entry.status === 'invalid'
        ? color.red('invalid')
        : entry.status === 'rate_limited'
          ? color.yellow('rate-limited')
          : entry.status === 'blocked'
            ? color.yellow('action needed')
            : entry.status === 'unverified'
              ? color.yellow('unverified')
              : color.green('ready');
    const used = entry.lastUsedAt ? `used ${formatRelativeTime(entry.lastUsedAt)} ago` : 'never used';
    const origin = entry.source === 'env' ? ` ${color.cyan('env')}` : '';
    process.stdout.write(
      `${marker} ${entry.name.padEnd(16)} ${entry.providerName.padEnd(12)} ${entry.masked.padEnd(22)} ${status.padEnd(20)} ${color.dim(used)}${origin}\n`,
    );
  }
  process.stdout.write(`\n${color.dim('Manage keys interactively with /keys inside mikuhost.')}\n`);
}

function providersCommand() {
  const config = new ConfigManager();
  config.load();
  const manager = new CredentialManager();
  const active = manager.activeEntry();
  const envProvider = detectedEnvProvider(process.env);
  process.stdout.write(`${color.bold('PROVIDERS')}\n\n`);
  for (const provider of providerList()) {
    const isActive = (active?.provider ?? config.providerId) === provider.id;
    const marker = isActive ? color.green('●') : color.dim('○');
    const stored = manager.list().filter((entry) => entry.provider === provider.id);
    const baseUrl = provider.id === 'custom' ? config.baseUrlFor('custom') || '(not set)' : config.baseUrlFor(provider.id);
    process.stdout.write(`${marker} ${provider.name} ${color.dim(`(${provider.id})`)}${isActive ? color.green('  active') : ''}\n`);
    process.stdout.write(`    ${color.dim('base URL')}  ${baseUrl}\n`);
    process.stdout.write(`    ${color.dim('env')}       ${provider.envKeys.join(', ')}${envProvider === provider.id ? color.cyan('  ← detected') : ''}\n`);
    process.stdout.write(`    ${color.dim('keys')}      ${stored.length ? stored.map((entry) => `${entry.name} ${entry.masked}`).join(', ') : 'none stored'}\n`);
    process.stdout.write(`    ${color.dim('models')}    ${config.modelFor(provider.id) ?? '(none configured)'}\n`);
  }
  process.stdout.write(
    `\n${color.dim('Add a key with `mikuhost keys add <name> <key>` — the provider is detected from the key prefix.')}\n` +
      `${color.dim('A stored base URL or TOKENHARBOR_BASE_URL / MIKUHOST_BASE_URL overrides the defaults above.')}\n`,
  );
  return 0;
}

/**
 * Verify a key with the real chat endpoint, exactly like the manual curl:
 * POST /chat/completions with a bearer token. A catalogue listing is not proof
 * of a working key. A 429 waits for Retry-After and retries once.
 */
async function probeKey(config, entry, key) {
  const providerId = resolveProviderId(entry.provider);
  const model = entry.model || config.modelFor(providerId);
  const provider = createProvider({
    provider: providerId,
    baseUrl: entry.baseUrl || config.baseUrlFor(providerId),
    apiKey: key,
  });
  const result = await provider.validateKey(key, {
    model,
    attempts: 2,
    onWait: ({ waitMs, next }) => {
      process.stdout.write(
        `${color.yellow('!')} Rate limited · waiting ${Math.ceil(waitMs / 1000)}s before attempt ${next}…\n`,
      );
    },
  });
  return { providerId, model, result };
}

function reportProbe(manager, entry, providerId, model, result) {
  if (result.valid) {
    manager.setStatus(entry.id, 'ready');
    process.stdout.write(
      `${color.green('✓')} ${entry.name}: key accepted by ${providerName(providerId)}${model ? ` with ${model}` : ''}${result.warning ? ` — ${result.warning}` : ''}. ${result.models?.length ?? 0} models available.\n`,
    );
    return 0;
  }
  if (result.blocked) {
    manager.setStatus(entry.id, 'blocked', result.error?.message);
    const detail = result.error?.message ?? 'account restricted';
    process.stdout.write(
      `${color.yellow('!')} ${entry.name}: ${providerName(providerId)} accepted the key, but the account needs action · ${detail}\n`,
    );
    return 1;
  }
  if (result.rateLimited) {
    manager.setStatus(entry.id, 'rate_limited', result.error?.message);
    const seconds = result.retryAfterMs ? Math.ceil(result.retryAfterMs / 1000) : null;
    process.stdout.write(
      `${color.yellow('!')} ${entry.name}: still rate limited${seconds ? ` · retry in ${seconds}s` : ''}. The key was not rejected; test again later.\n`,
    );
    return 1;
  }
  if (result.offline) {
    process.stdout.write(`${color.yellow('!')} Network unreachable; key could not be verified.\n`);
    return 1;
  }
  if (result.inconclusive) {
    process.stdout.write(`${color.yellow('!')} Provider returned an unexpected error: ${result.error?.message}\n`);
    return 1;
  }
  manager.setStatus(entry.id, 'invalid', result.error?.message);
  process.stdout.write(`${color.red('✗')} ${entry.name}: ${result.error?.message}\n`);
  return 1;
}

async function testKey(manager, selector) {
  const entry = parseKeySelector(manager, selector);
  if (!entry) {
    process.stderr.write(`${color.red('Key not found.')} Use \`mikuhost keys\` to list keys.\n`);
    return 1;
  }
  const config = new ConfigManager();
  config.load();
  const providerId = resolveProviderId(entry.provider);
  const model = entry.model || config.modelFor(providerId);
  process.stdout.write(
    `Testing ${entry.name} · ${providerName(providerId)} · ${entry.key.length} chars (ends …${entry.key.slice(-4)})${model ? ` · ${model}` : ''}…\n`,
  );
  try {
    const { result } = await probeKey(config, entry, entry.key);
    return reportProbe(manager, entry, providerId, model, result);
  } catch (error) {
    process.stderr.write(`${color.red('Test failed:')} ${error.message}\n`);
    return 1;
  }
}

async function keysCommand(args, options = {}) {
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
    const requested = options.provider ? resolveProviderId(options.provider) : null;
    if (options.provider && !getProvider(options.provider)) {
      process.stderr.write(
        `${color.red(`Unknown provider: ${options.provider}`)}. Use one of: ${providerIds().join(', ')}\n`,
      );
      return 2;
    }
    const check = validateKeyFormat(key, { provider: requested });
    if (!check.ok) {
      process.stderr.write(`${color.red(check.reason)}\n`);
      return 2;
    }
    if (check.warning) process.stderr.write(`${color.yellow(check.warning)}\n`);
    try {
      const added = manager.add({ name, key, provider: requested });
      const config = new ConfigManager();
      config.load();
      // Adding a key does not steal the active slot from an existing key; the
      // config provider always follows whichever key is actually active.
      config.setProvider(manager.activeEntry()?.provider ?? added.provider);
      process.stdout.write(
        `${color.green('✓')} Added ${added.name} (${added.masked}, ${key.length} chars, ends …${key.slice(-4)}) · ${added.providerName}.\n`,
      );
      // Verify immediately with a real completion, the same request the agent
      // will send; a catalogue listing can succeed for a key chat rejects. The
      // key is already stored, so a failed probe never undoes the add.
      const providerId = resolveProviderId(added.provider);
      const model = added.model || config.modelFor(providerId);
      const baseUrl = added.baseUrl || config.baseUrlFor(providerId);
      if (!baseUrl) {
        process.stdout.write(
          `${color.dim('No base URL configured for this provider; skipping the verification request.')}\n`,
        );
        return 0;
      }
      process.stdout.write(`Testing with a real completion${model ? ` (${model})` : ''}…\n`);
      try {
        const probe = await probeKey(config, added, key);
        reportProbe(manager, added, probe.providerId, probe.model, probe.result);
      } catch (error) {
        process.stdout.write(`${color.yellow('!')} Verification skipped: ${error.message}\n`);
      }
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
    const config = new ConfigManager();
    config.load();
    config.setProvider(entry.provider);
    process.stdout.write(
      `${color.green('✓')} Active key: ${entry.name} · ${providerName(entry.provider)} (${maskKey(entry.key)}).\n`,
    );
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
    process.stdout.write(`    ${color.dim(model.id)} · ${color.dim(model.provider ?? 'nvidia')}\n`);
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
  if (options.provider) {
    if (!getProvider(options.provider)) {
      process.stderr.write(
        `${color.red(`Unknown provider: ${options.provider}`)}. Use one of: ${providerIds().join(', ')}\n`,
      );
      return 2;
    }
    const providerId = resolveProviderId(options.provider);
    const manager = new CredentialManager();
    const entry = manager.firstForProvider(providerId);
    if (entry) {
      manager.setActive(entry.id);
      config.setProvider(providerId);
    } else {
      process.stderr.write(
        `${color.yellow('No key for provider')} ${providerName(providerId)}\n` +
          `Add one: ${color.bold(`mikuhost keys add <name> <key> --provider ${providerId}`)}\n` +
          `or set ${getProvider(providerId).envKeys.join(' / ')} in the environment.\n`,
      );
      return 1;
    }
  }
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
      return keysCommand(parsed.args, parsed.options);
    case 'providers':
      return providersCommand();
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
