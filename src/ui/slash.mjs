export const SLASH_COMMANDS = [
  { name: 'help', usage: '/help', description: 'Show commands and keyboard shortcuts' },
  { name: 'new', usage: '/new', description: 'Start a new session' },
  { name: 'sessions', usage: '/sessions', description: 'Open saved sessions' },
  { name: 'model', usage: '/model <id|index>', description: 'Switch model directly' },
  { name: 'models', usage: '/models', description: 'Open the model switcher' },
  { name: 'keys', usage: '/keys', description: 'Manage API keys (provider detected from the key)' },
  { name: 'paste', usage: '/paste', description: 'Capture one paste as a single attachment (Ctrl+D finish, Esc cancel)' },
  { name: 'attachments', usage: '/attachments', description: 'Preview pasted text attachments' },
  { name: 'projects', usage: '/projects', description: 'List discovered projects' },
  { name: 'project', usage: '/project <name|all>', description: 'Focus a project (or clear focus)' },
  { name: 'workspace', usage: '/workspace [path|reset]', description: 'Change or reset the workspace' },
  { name: 'settings', usage: '/settings', description: 'Permissions settings' },
  { name: 'permissions', usage: '/permissions <shell|file|sensitive> <ask|allow|auto>', description: 'Set a permission policy (auto = unattended)' },
  { name: 'reasoning', usage: '/reasoning [on|off|auto]', description: 'Show or hide provider reasoning' },
  { name: 'status', usage: '/status', description: 'Show runtime status' },
  { name: 'clear', usage: '/clear', description: 'Erase this session’s conversation' },
  { name: 'compact', usage: '/compact', description: 'Show how the context window is compacted' },
  { name: 'continue', usage: '/continue', description: 'Resume the last turn if it never got an answer' },
  { name: 'undo', usage: '/undo [list|force]', description: 'Restore the file the agent changed last' },
  { name: 'rename', usage: '/rename <title>', description: 'Rename the current session' },
  { name: 'mouse', usage: '/mouse <on|off>', description: 'Toggle mouse click support' },
  { name: 'exit', usage: '/exit', description: 'Quit MikuHost Agent' },
];

export function parseSlash(input) {
  const text = String(input ?? '').trim();
  if (!text.startsWith('/')) return null;
  const body = text.slice(1);
  const space = body.search(/\s/);
  const name = (space === -1 ? body : body.slice(0, space)).toLowerCase();
  const rest = space === -1 ? '' : body.slice(space + 1).trim();
  return { name, args: rest, argv: rest ? rest.split(/\s+/) : [] };
}

export function suggestCommands(input) {
  const text = String(input ?? '');
  if (!text.startsWith('/') || text.includes(' ')) return [];
  const needle = text.slice(1).toLowerCase();
  if (!needle) return SLASH_COMMANDS.slice(0, 6);
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(needle)).slice(0, 6);
}

export function completeCommand(input) {
  if (!String(input ?? '').startsWith('/') || input.includes(' ')) return null;
  const matches = suggestCommands(input);
  if (!matches.length) return null;
  const names = matches.map((command) => `/${command.name}`);
  if (names.length === 1) return `${names[0]} `;
  let prefix = names[0];
  for (const name of names.slice(1)) {
    while (prefix && !name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix.length > 1 ? prefix : null;
}

export const HELP_TEXT = [
  'Commands:',
  ...SLASH_COMMANDS.map((command) => `  ${command.usage.padEnd(46)} ${command.description}`),
  '',
  'Keyboard:',
  '  ← Sessions (when input is empty)     → Models (when input is empty)',
  '  Alt+← / Alt+→ open panels from anywhere',
  '  ↑ / ↓ input history                  PgUp / PgDn scroll the conversation',
  '  Ctrl+Home / Ctrl+End transcript top  Enter send · Alt/Shift+Enter newline',
  '  Tab select pasted attachment          Esc remove the selected attachment',
  '  /paste capture next paste             Ctrl+D attach it · Esc cancel',
  '  Ctrl+R expand/collapse reasoning      Ctrl+X remove last pasted attachment',
  '  Ctrl+J insert newline',
  '  Ctrl+N new session                   Ctrl+C cancel the running turn',
  '  Ctrl+L clear the screen view         Tab complete a slash command',
  '  (Left/Right still move the text cursor while you type.)',
  '',
  'Paste markers (composer footer):',
  '  bracketed ✓  terminal sent real paste markers · one block = one attachment',
  '  bracketed ?  no marker seen yet · fallback batching · /paste for a hard boundary',
].join('\n');
