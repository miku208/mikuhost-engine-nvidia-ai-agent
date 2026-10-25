export const COMMANDS = ['doctor', 'keys', 'models', 'sessions', 'help', 'version'];

export const USAGE = `MikuHost Agent — AI coding agent for the terminal

Usage:
  mikuhost                          Start a NEW session (first run opens setup)
  mikuhost --resume                 Resume the most recent session
  mikuhost --session <id>           Open a specific saved session
  mikuhost --workspace <path>       Start with a specific workspace directory
  mikuhost --model <id>             Start with a specific model
  mikuhost doctor                   Run environment diagnostics
  mikuhost doctor --keyboard        Inspect raw keyboard bytes (Backspace/Delete testing)
  mikuhost keys [list|add|remove|rename|test|use|switch]
  mikuhost models                   List configured models
  mikuhost sessions                 List saved sessions
  mikuhost --help                   Show this help
  mikuhost --version                Show the version

Keyboard diagnosis:
  mikuhost doctor --keyboard     Shows raw bytes + normalized keys; Ctrl+C exits

Keys management (non-interactive):
  mikuhost keys add <name> <key>
  mikuhost keys remove <id|name>
  mikuhost keys rename <id|name> <new name>
  mikuhost keys test [id|name]
  mikuhost keys use <id|name>        (alias: keys switch <id|name>)

Environment:
  MIKUHOST_WORKSPACE      Default workspace (overridden by --workspace)
  MIKUHOST_CONFIG_DIR     Config directory (default ~/.config/mikuhost)
  MIKUHOST_BASE_URL       NVIDIA API base URL
  MIKUHOST_ENCRYPTION_KEY Passphrase used to encrypt credentials.json
  MIKUHOST_MOUSE=0        Disable mouse click support in the TUI
  NO_COLOR                Disable colours
`;

const VALUE_FLAGS = new Set(['workspace', 'model', 'base-url', 'session']);

export function parseArgs(argv = []) {
  const options = {};
  const positional = [];
  const errors = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const [rawName, inlineValue] = token.slice(2).split('=');
      const name = rawName.trim();
      if (
        name === 'help' ||
        name === 'version' ||
        name === 'no-mouse' ||
        name === 'no-color' ||
        name === 'keyboard' ||
        name === 'resume'
      ) {
        options[name] = true;
        continue;
      }
      if (VALUE_FLAGS.has(name)) {
        let value = inlineValue;
        if (value === undefined) {
          value = argv[i + 1];
          if (value === undefined || value.startsWith('--')) {
            errors.push(`Option --${name} requires a value.`);
            continue;
          }
          i += 1;
        }
        options[name] = value;
        continue;
      }
      errors.push(`Unknown option: --${name}`);
      continue;
    }
    if (token === '-h') {
      options.help = true;
      continue;
    }
    if (token === '-v' || token === '-V') {
      options.version = true;
      continue;
    }
    if (token.startsWith('-')) {
      errors.push(`Unknown option: ${token}`);
      continue;
    }
    positional.push(token);
  }

  const command = positional[0] ?? null;
  if (command && !COMMANDS.includes(command)) {
    errors.push(`Unknown command: ${command}`);
  }
  if (options.keyboard && command !== 'doctor') {
    errors.push('--keyboard is only valid with the doctor command (mikuhost doctor --keyboard).');
  }
  if (options.resume && options.session) {
    errors.push('Use either --resume or --session <id>, not both.');
  }

  return {
    command,
    args: positional.slice(1),
    options,
    errors,
    help: Boolean(options.help) || command === 'help',
    version: Boolean(options.version) || command === 'version',
  };
}

export function parseKeySelector(credentialManager, selector) {
  if (!selector) return credentialManager.activeEntry();
  const entries = credentialManager.list();
  const needle = String(selector).trim().toLowerCase();
  const exactId = entries.find((entry) => entry.id.toLowerCase() === needle);
  if (exactId) return credentialManager.get(exactId.id);
  const exactName = entries.find((entry) => entry.name.toLowerCase() === needle);
  if (exactName) return credentialManager.get(exactName.id);
  const fuzzy = entries.filter((entry) => entry.name.toLowerCase().includes(needle));
  if (fuzzy.length === 1) return credentialManager.get(fuzzy[0].id);
  return null;
}
