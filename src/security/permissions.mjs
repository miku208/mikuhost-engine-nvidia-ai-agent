// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import path from 'node:path';
import { isPathInside } from './workspace.mjs';
import { classifySensitive, looksLikeSecretReference } from './sensitive-files.mjs';

/**
 * Permission model
 * ----------------
 * shell mode "ask"   -> every command needs approval.
 * shell mode "allow" -> commands classified as `safe` or `project` run
 *                       automatically; `guarded` and `critical` still ask.
 * shell mode "auto"  -> unattended: every command runs, including guarded and
 *                       critical ones. Explicitly chosen by the user (Settings →
 *                       Unattended mode) so the agent can finish a task without
 *                       anyone at the keyboard; it is not a sandbox.
 *
 * Risk classes:
 *   safe     - read-only inspection (ls, cat of non-secret files, git status, ...)
 *   project  - local project tooling (tests, builds, local scripts, file moves)
 *   guarded  - installs, network egress, opaque interpreters, credential access,
 *              service managers, privilege escalation
 *   critical - destructive operations (rm -rf, git reset --hard, mkfs, ...)
 *
 * The analysis is a *defence in depth* layer, not a sandbox: `node build.js`
 * is classified as project tooling and can do anything the OS user can do.
 * README documents this limitation; running as a limited OS user is the only
 * real isolation.
 */

export const SHELL_MODES = Object.freeze(['ask', 'allow', 'auto']);

const RISK_ORDER = { safe: 0, project: 1, guarded: 2, critical: 3 };

const SAFE_COMMANDS = new Set([
  'ls', 'pwd', 'wc',
  'file', 'stat', 'du', 'df', 'tree', 'which', 'whereis', 'type', 'whoami', 'id',
  'uname', 'hostname', 'date', 'uptime', 'free', 'echo', 'printf', 'basename',
  'dirname', 'realpath', 'readlink', 'md5sum', 'sha1sum', 'sha256sum', 'shasum',
  'diff', 'cmp', 'comm', 'sort', 'uniq', 'cut', 'tr', 'column', 'xxd', 'od', 'hexdump',
  'true', 'false', 'test', '[', 'jq', 'ps', 'cd', 'sleep',
]);

const PROJECT_COMMANDS = new Set([
  'npm', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'npx', 'tsc', 'vite', 'jest', 'vitest',
  'mocha', 'make', 'cmake', 'cargo', 'rustc', 'go', 'python', 'python3', 'pip', 'pip3',
  'pytest', 'ruff', 'eslint', 'prettier', 'php', 'composer', 'ruby', 'bundle', 'mvn',
  'gradle', './gradlew', 'dotnet', 'phpunit', 'babel', 'webpack', 'rollup', 'esbuild',
  'mkdir', 'touch', 'cp', 'mv', 'ln', 'git', 'chmod', 'chown', 'chgrp', 'sed', 'tee',
  'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'patch', 'pm2', 'sqlite3', 'psql', 'mysql',
]);

const GUARDED_COMMANDS = new Set([
  'sudo', 'doas', 'su', 'pkexec',
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync', 'ftp',
  'apt', 'apt-get', 'apk', 'yum', 'dnf', 'pacman', 'zypper', 'brew', 'snap', 'flatpak',
  'docker', 'podman', 'kubectl', 'helm', 'terraform', 'ansible', 'ansible-playbook',
  'systemctl', 'service', 'journalctl', 'crontab', 'at', 'batch',
  'kill', 'killall', 'pkill', 'xkill',
  'shutdown', 'reboot', 'poweroff', 'halt', 'init', 'telinit',
  'mount', 'umount', 'swapon', 'swapoff', 'fdisk', 'parted', 'losetup', 'cryptsetup',
  'mkfs', 'mke2fs', 'dd', 'fsck', 'tune2fs', 'hdparm',
  'iptables', 'nft', 'ufw', 'firewall-cmd',
  'useradd', 'userdel', 'usermod', 'groupadd', 'groupdel', 'passwd', 'visudo',
  'eval', 'exec', 'source', '.', 'xargs', 'watch', 'envsubst',
  'history', 'set', 'export', 'declare', 'typeset', 'alias', 'unalias',
  'base64', 'openssl', 'gpg', 'ssh-keygen',
  'nmap', 'tcpdump', 'socat', 'ngrok',
]);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'fish', 'csh', 'tcsh', 'busybox']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua']);
const NETWORK_COMMANDS = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'telnet', 'socat']);
const INSTALLERS = new Set(['apt', 'apt-get', 'apk', 'yum', 'dnf', 'pacman', 'zypper', 'brew', 'snap', 'flatpak']);
const DESTRUCTIVE_NAMES = new Set(['mkfs', 'mke2fs', 'dd', 'shutdown', 'reboot', 'poweroff', 'halt', 'init', 'telinit', 'wipefs', 'shred']);

// Redirects people use to silence output. Writing to /dev/null discards the
// data and reading it returns EOF, so neither is a filesystem side effect and
// neither should turn an otherwise read-only command into "needs approval".
const HARMLESS_REDIRECT_TARGETS = new Set(['/dev/null']);

const WRAPPERS = new Set(['sudo', 'doas', 'command', 'time', 'nohup', 'nice', 'ionice', 'stdbuf', 'timeout', 'env', 'builtin']);

export function tokenizeShell(command) {
  const text = String(command ?? '');
  const tokens = [];
  let buffer = '';
  let started = false;
  let quote = null;
  let dynamic = false;

  const pushWord = () => {
    if (started) {
      tokens.push({ type: 'word', value: buffer });
      buffer = '';
      started = false;
    }
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else buffer += ch;
      started = true;
      continue;
    }

    if (quote === '"') {
      if (ch === '\\') {
        const next = text[i + 1];
        if (next !== undefined && '"\\$`\n'.includes(next)) {
          buffer += next;
          i += 1;
        } else {
          buffer += ch;
        }
        started = true;
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === '`' || (ch === '$' && text[i + 1] === '(') || (ch === '$' && text[i + 1] === '{')) dynamic = true;
      buffer += ch;
      started = true;
      continue;
    }

    if (ch === '\\') {
      const next = text[i + 1];
      if (next === '\n') {
        i += 1;
        continue;
      }
      if (next !== undefined) {
        buffer += next;
        started = true;
        i += 1;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }

    if (ch === '$' && (text[i + 1] === '(' || text[i + 1] === '{')) {
      dynamic = true;
      buffer += ch;
      started = true;
      continue;
    }
    if (ch === '`') {
      dynamic = true;
      buffer += ch;
      started = true;
      continue;
    }

    if (/\s/.test(ch)) {
      pushWord();
      continue;
    }

    if (ch === '#' && !started) {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '>' || ch === '<' || (ch === '&' && text[i + 1] === '>')) {
      let fd = null;
      let op = '';
      if (ch === '&') {
        op = '&>';
        i += 1;
      } else {
        if (/^\d+$/.test(buffer) && started) {
          fd = Number(buffer);
          buffer = '';
          started = false;
        }
        op = ch;
        const next = text[i + 1];
        if (next === ch) {
          op += ch;
          i += 1;
        } else if (next === '&') {
          op += '&';
          i += 1;
        } else if (next === '|') {
          op += '|';
          i += 1;
        }
      }
      pushWord();
      tokens.push({ type: 'redirect', op, fd });
      continue;
    }

    if (ch === '&' && text[i + 1] === '&') {
      pushWord();
      tokens.push({ type: 'op', value: '&&' });
      i += 1;
      continue;
    }
    if (ch === '|' && text[i + 1] === '|') {
      pushWord();
      tokens.push({ type: 'op', value: '||' });
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '\n') {
      pushWord();
      tokens.push({ type: 'op', value: ch === '\n' ? ';' : ch });
      continue;
    }

    buffer += ch;
    started = true;
  }

  pushWord();
  return { tokens, dynamic, hasHeredoc: tokens.some((t) => t.type === 'redirect' && t.op === '<<') };
}

export function splitSegments(tokens) {
  const segments = [];
  const redirects = [];
  let current = { argv: [], raw: '' };

  const flush = () => {
    if (current.argv.length || current.raw.trim()) {
      if (current.argv.length) segments.push(current);
    }
    current = { argv: [], raw: '' };
  };

  let expectRedirectTarget = null;
  for (const token of tokens) {
    if (token.type === 'op') {
      flush();
      expectRedirectTarget = null;
      continue;
    }
    if (token.type === 'redirect') {
      if (token.op === '<<') {
        redirects.push({ op: token.op, fd: token.fd, target: null, heredoc: true });
        expectRedirectTarget = null;
        continue;
      }
      expectRedirectTarget = { op: token.op, fd: token.fd };
      continue;
    }
    if (expectRedirectTarget) {
      redirects.push({ ...expectRedirectTarget, target: token.value });
      expectRedirectTarget = null;
      current.raw += ` ${token.value}`;
      continue;
    }
    current.argv.push(token.value);
    current.raw += `${current.raw ? ' ' : ''}${token.value}`;
  }
  flush();
  return { segments, redirects, danglingRedirect: Boolean(expectRedirectTarget) };
}

function commandName(argv) {
  const raw = String(argv[0] ?? '');
  const base = path.basename(raw).toLowerCase();
  return base.replace(/\.exe$/, '');
}

function unwrap(argv) {
  let rest = [...argv];
  let elevated = false;
  let wrapperGuard = false;
  for (let depth = 0; depth < 6; depth += 1) {
    if (!rest.length) break;
    const name = commandName(rest);
    if (!WRAPPERS.has(name)) break;
    if (name === 'sudo' || name === 'doas') elevated = true;
    if (name === 'command' || name === 'builtin') wrapperGuard = true;
    let i = 1;
    while (i < rest.length) {
      const token = rest[i];
      if (token === '--') {
        i += 1;
        break;
      }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        i += 1;
        continue;
      }
      if ((name === 'sudo' || name === 'doas') && ['-u', '-g', '-p', '-C', '-U', '-r', '-t', '-T', '-D'].includes(token)) {
        i += 2; // option plus its value
        continue;
      }
      if (name === 'timeout' || name === 'nice' || name === 'ionice' || name === 'stdbuf') {
        if (token.startsWith('-')) {
          i += 1;
          continue;
        }
        i += 1; // duration / priority value
        continue;
      }
      if (token.startsWith('-')) {
        i += 1;
        continue;
      }
      break;
    }
    rest = rest.slice(i);
  }
  return { argv: rest, elevated, wrapperGuard };
}

function hasFlag(argv, shortLetters = '', longFlags = []) {
  for (const token of argv) {
    if (typeof token !== 'string') continue;
    if (!token.startsWith('-')) continue;
    const name = token.split('=')[0];
    // Long-style options also exist with a single dash (find -delete, xargs -0).
    if (longFlags.includes(name)) return true;
    if (token.startsWith('--')) continue;
    if (/^-[A-Za-z]+$/.test(token)) {
      for (const letter of shortLetters) {
        if (token.includes(letter)) return true;
      }
    }
  }
  return false;
}

function addReason(reasons, text) {
  if (text && !reasons.includes(text)) reasons.push(text);
}

function bump(state, risk, reason) {
  if (RISK_ORDER[risk] > RISK_ORDER[state.risk]) state.risk = risk;
  addReason(state.reasons, reason);
}

function looksLikePathArg(token) {
  if (typeof token !== 'string' || !token) return false;
  if (token.includes('/') || token.startsWith('.') || token.startsWith('~')) return true;
  return false;
}

function referencesOutsideWorkspace(token, workspaceRoot) {
  if (!workspaceRoot || !looksLikePathArg(token)) return false;
  const value = token.replace(/^['"]|['"]$/g, '');
  if (!value) return false;
  const absolute = path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value);
  return !isPathInside(workspaceRoot, absolute);
}

function scanTokens(tokens, state, workspaceRoot) {
  for (const token of tokens) {
    if (typeof token !== 'string') continue;
    if (looksLikeSecretReference(token)) {
      bump(state, 'guarded', `references credential material (${token.split('/').pop()})`);
    }
    if (/\/proc\/(self|\d+)\/environ/.test(token)) {
      bump(state, 'guarded', 'reads process environment from /proc');
    }
    if (referencesOutsideWorkspace(token, workspaceRoot) && /(^|\/)(etc|boot|sys|proc|dev)\//.test(token)) {
      bump(state, 'guarded', `touches a system path outside the workspace (${token})`);
    }
  }
}

function analyzeSegment(argvInput, state, workspaceRoot) {
  const { argv, elevated, wrapperGuard } = unwrap(argvInput);
  if (!argv.length) return;
  if (elevated) bump(state, 'guarded', 'requests elevated privileges (sudo/su)');
  if (wrapperGuard) bump(state, 'guarded', 'uses a shell builtin wrapper');

  const name = commandName(argv);
  const args = argv.slice(1);
  scanTokens(argv, state, workspaceRoot);

  if (!name) return;

  if (name === 'rm') {
    const recursive = hasFlag(args, 'rR', ['--recursive']);
    const force = hasFlag(args, 'f', ['--force', '--no-preserve-root']);
    const outside = args.some((arg) => referencesOutsideWorkspace(arg, workspaceRoot));
    if (recursive && force) {
      bump(state, 'critical', 'destructive filesystem operation (rm -rf)');
      if (outside || args.includes('/') || args.includes('~')) bump(state, 'critical', 'rm -rf targets a path outside the project');
    } else if (recursive) {
      bump(state, 'guarded', 'recursive file deletion (rm -r)');
    } else {
      bump(state, 'guarded', 'deletes files (rm)');
    }
    return;
  }

  if (name === 'find') {
    if (hasFlag(args, '', ['-delete'])) bump(state, 'critical', 'find -delete removes files');
    else if (args.some((arg) => ['-exec', '-execdir', '-ok', '-okdir'].includes(arg))) {
      bump(state, 'guarded', 'find executes another command');
    } else bump(state, 'safe', null);
    return;
  }

  if (name === 'sed' && hasFlag(args, 'i', ['--in-place'])) {
    bump(state, 'project', null);
    return;
  }

  if (name === 'git') {
    const sub = String(args[0] ?? '').toLowerCase();
    if (sub === 'reset' && hasFlag(args, '', ['--hard'])) {
      bump(state, 'critical', 'git reset --hard discards local changes');
      return;
    }
    if (sub === 'clean' && (hasFlag(args, 'fdx', ['--force']))) {
      bump(state, 'critical', 'git clean deletes untracked files');
      return;
    }
    if (sub === 'checkout' && args.includes('--')) {
      bump(state, 'guarded', 'git checkout can discard local changes');
      return;
    }
    if (sub === 'push') {
      bump(state, 'guarded', 'git push publishes to a remote');
      return;
    }
    if (['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'describe', 'branch', 'tag', 'remote'].includes(sub)) {
      if (sub === 'branch' && hasFlag(args, 'dD', ['--delete'])) bump(state, 'guarded', 'git branch deletion');
      else bump(state, 'safe', null);
      return;
    }
    if (['commit', 'add', 'merge', 'rebase', 'stash', 'cherry-pick', 'revert', 'init', 'clone', 'fetch', 'pull'].includes(sub)) {
      bump(state, 'project', null);
      return;
    }
    bump(state, 'guarded', `git ${sub || '(no subcommand)'}`);
    return;
  }

  if (name === 'chmod' || name === 'chown' || name === 'chgrp') {
    if (hasFlag(args, 'R', ['--recursive'])) {
      bump(state, 'critical', `${name} -R changes permissions recursively`);
    } else {
      bump(state, 'project', null);
    }
    return;
  }

  if (name === 'pm2') {
    const sub = String(args[0] ?? '').toLowerCase();
    if (['delete', 'kill', 'flush', 'unstartup'].includes(sub) || args.includes('all') && sub === 'delete') {
      bump(state, 'critical', `pm2 ${sub} stops or removes running processes`);
    } else {
      bump(state, 'project', null);
    }
    return;
  }

  if (name === 'systemctl' || name === 'service' || name === 'journalctl') {
    const destructive = ['stop', 'disable', 'mask', 'kill', 'restart'].some((word) => args.includes(word));
    bump(state, destructive ? 'critical' : 'guarded',
      destructive ? `${name} ${args.find((a) => ['stop', 'disable', 'mask', 'kill', 'restart'].includes(a))} affects system services` : `${name} affects system services`);
    return;
  }

  if (DESTRUCTIVE_NAMES.has(name)) {
    bump(state, 'critical', `${name} is a destructive system operation`);
    return;
  }

  if (name === 'kill' || name === 'pkill' || name === 'killall') {
    if (args.includes('-1') || args.includes('-9')) bump(state, 'critical', `${name} with signal 9/-1 can kill critical processes`);
    else bump(state, 'guarded', `${name} terminates processes`);
    return;
  }

  if (name === 'curl' || name === 'wget') {
    bump(state, 'guarded', `network download (${name})`);
    const piped = argvInput.join(' ');
    if (/\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node)\b/.test(piped)) {
      bump(state, 'critical', 'pipes a network download directly into an interpreter');
    }
    return;
  }

  if (NETWORK_COMMANDS.has(name) && name !== 'curl' && name !== 'wget') {
    bump(state, 'guarded', `network access (${name})`);
    return;
  }

  if (INSTALLERS.has(name)) {
    bump(state, 'guarded', `system package manager (${name})`);
    return;
  }

  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    const sub = String(args[0] ?? '').toLowerCase();
    if (['install', 'i', 'add', 'ci', 'update', 'up', 'upgrade', 'link', 'unlink'].includes(sub) || sub === '') {
      bump(state, 'guarded', 'package install runs third-party lifecycle scripts');
      return;
    }
    if (['test', 't', 'run', 'run-script', 'start', 'build', 'lint', 'exec', 'create'].includes(sub)) {
      if (sub === 'create' || sub === 'exec') {
        bump(state, 'guarded', `${name} ${sub} downloads and executes code`);
        return;
      }
      bump(state, 'project', null);
      return;
    }
    if (['publish', 'deprecate', 'unpublish'].includes(sub)) {
      bump(state, 'guarded', `${name} publishes to a registry`);
      return;
    }
    bump(state, 'guarded', `${name} ${sub || '(no subcommand)'} can execute project code`);
    return;
  }

  if (name === 'npx' || name === 'pnpx' || name === 'bunx') {
    bump(state, 'guarded', `${name} downloads and executes a package`);
    return;
  }

  if (name === 'pip' || name === 'pip3') {
    if (args[0] === 'install' || args[0] === 'uninstall') bump(state, 'guarded', 'pip install runs package build hooks');
    else bump(state, 'project', null);
    return;
  }

  if (name === 'node' || name === 'python' || name === 'python3' || name === 'ruby' || name === 'perl' || name === 'php' || name === 'deno' || name === 'bun') {
    if (hasFlag(args, 'eEc', ['--eval', '--print', '-e', '-c'])) {
      bump(state, 'guarded', `inline code via ${name} cannot be verified statically`);
      return;
    }
    bump(state, 'project', null);
    return;
  }

  if (SHELLS.has(name)) {
    if (hasFlag(args, 'c', ['--command'])) {
      bump(state, 'guarded', `shell wrapper (${name} -c) cannot be verified statically`);
      return;
    }
    if (hasFlag(args, 'i', ['--login', '-l'])) {
      bump(state, 'guarded', 'interactive/login shell');
      return;
    }
    bump(state, 'project', null);
    return;
  }

  if (INTERPRETERS.has(name)) {
    bump(state, 'project', null);
    return;
  }

  if (name === 'env' || name === 'printenv' || name === 'set' || name === 'export' || name === 'declare' || name === 'history') {
    if (args.length === 0 || name === 'history') {
      bump(state, 'guarded', `${name} can expose secrets from the environment or shell history`);
      return;
    }
    bump(state, 'safe', null);
    return;
  }

  if (['base64', 'openssl', 'gpg', 'ssh-keygen'].includes(name)) {
    bump(state, 'guarded', `${name} can reveal or replace key material`);
    return;
  }

  if (SAFE_COMMANDS.has(name)) {
    bump(state, 'safe', null);
    return;
  }

  if (name === 'cat' || name === 'head' || name === 'tail' || name === 'grep' || name === 'rg' || name === 'less' || name === 'more') {
    const secret = args.find((arg) => looksLikeSecretReference(arg));
    if (secret) bump(state, 'guarded', `reads credential material (${path.basename(secret)})`);
    else bump(state, name === 'less' || name === 'more' ? 'guarded' : 'safe', null);
    return;
  }

  if (PROJECT_COMMANDS.has(name)) {
    bump(state, 'project', null);
    return;
  }

  bump(state, 'guarded', `unrecognised command (${name}) executes with your OS permissions`);
}

export function analyzeCommand(command, { workspaceRoot = null } = {}) {
  const text = String(command ?? '').trim();
  const state = { risk: 'safe', reasons: [] };
  if (!text) {
    return { risk: 'critical', reasons: ['empty command'], segments: [], redirects: [], dynamic: false, hasHeredoc: false };
  }
  const { tokens, dynamic, hasHeredoc } = tokenizeShell(text);
  const { segments, redirects } = splitSegments(tokens);

  if (dynamic) bump(state, 'guarded', 'command uses dynamic shell expansion ($(...), ${...} or backticks)');
  if (hasHeredoc) bump(state, 'guarded', 'command uses a heredoc whose contents cannot be verified');

  for (const segment of segments) analyzeSegment(segment.argv, state, workspaceRoot);

  if (!segments.length) bump(state, 'guarded', 'no executable segment found');

  for (const redirect of redirects) {
    if (!redirect.target || ['>&', '<&'].includes(redirect.op)) continue;
    if (redirect.target.startsWith('/dev/')) {
      if (HARMLESS_REDIRECT_TARGETS.has(path.normalize(redirect.target))) continue;
      if (redirect.op !== '<') bump(state, 'guarded', `writes to ${redirect.target}`);
      continue;
    }
    if (looksLikeSecretReference(redirect.target)) {
      bump(state, 'guarded', `redirects output into credential file (${path.basename(redirect.target)})`);
      continue;
    }
    if (referencesOutsideWorkspace(redirect.target, workspaceRoot)) {
      bump(state, 'guarded', `writes a file outside the workspace (${redirect.target})`);
    }
  }

  if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node)\b/.test(text)) {
    bump(state, 'critical', 'pipes a downloaded script directly into an interpreter');
  }

  if (state.reasons.length === 0) addReason(state.reasons, 'read-only command');
  return { risk: state.risk, reasons: state.reasons, segments, redirects, dynamic, hasHeredoc };
}

export function evaluateShellCommand({ command, mode = 'ask', workspaceRoot = null } = {}) {
  const analysis = analyzeCommand(command, { workspaceRoot });
  const resolved = SHELL_MODES.includes(mode) ? mode : 'ask';
  // Unattended approves everything; allow mode approves safe/project only. The
  // risk classification is still returned so the transcript keeps saying what
  // ran, even when nobody was asked.
  const autoAllowed =
    resolved === 'auto' || (resolved === 'allow' && (analysis.risk === 'safe' || analysis.risk === 'project'));
  return {
    ...analysis,
    mode: resolved,
    decision: autoAllowed ? 'auto' : 'ask',
    requiresApproval: !autoAllowed,
  };
}

/** Read policy: normal reads are automatic; sensitive reads depend on config. */
export function evaluateFileRead({ target, mode = 'ask' } = {}) {
  const classification = classifySensitive(target);
  if (!classification.sensitive) return { decision: 'auto', requiresApproval: false, sensitive: false, reason: null };
  if (mode === 'allow' || mode === 'auto') {
    return { decision: 'auto', requiresApproval: false, sensitive: true, reason: classification.reason };
  }
  return { decision: 'ask', requiresApproval: true, sensitive: true, reason: classification.reason };
}

/** Write policy: writes always need approval unless explicitly configured off. */
export function evaluateFileWrite({ target, mode = 'ask' } = {}) {
  const classification = classifySensitive(target);
  // Unattended mode is the explicit "leave it running" choice, so it covers
  // credential files too; allow/ask keep protecting them.
  if (mode === 'auto') return { decision: 'auto', requiresApproval: false, sensitive: classification.sensitive, reason: null };
  if (classification.sensitive) {
    // A shell "always allow" or fileWrite=allow setting must never silently
    // overwrite credential material.
    return {
      decision: 'ask',
      requiresApproval: true,
      sensitive: true,
      reason: classification.reason,
    };
  }
  if (mode === 'allow') return { decision: 'auto', requiresApproval: false, sensitive: false, reason: null };
  return { decision: 'ask', requiresApproval: true, sensitive: false, reason: 'file modification' };
}

export function describeRisk(risk) {
  switch (risk) {
    case 'safe':
      return 'read-only';
    case 'project':
      return 'project tooling';
    case 'guarded':
      return 'guarded';
    case 'critical':
      return 'high risk';
    default:
      return 'unknown';
  }
}
