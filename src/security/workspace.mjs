// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LIMITS = Object.freeze({
  maxReadBytes: 512 * 1024,
  maxWriteBytes: 1024 * 1024,
  maxListEntries: 500,
  maxSearchResults: 200,
  maxSearchFiles: 5000,
  maxSearchFileBytes: 512 * 1024,
  maxCommandOutputBytes: 64 * 1024,
  maxCommandLength: 4000,
  defaultCommandTimeoutMs: 30_000,
  maxCommandTimeoutMs: 600_000,
});

export class WorkspaceError extends Error {
  constructor(message, code = 'WORKSPACE') {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

export function isPathInside(root, target, { caseInsensitive = process.platform === 'win32' } = {}) {
  let from = path.resolve(root);
  let to = path.resolve(target);
  if (caseInsensitive) {
    from = from.toLowerCase();
    to = to.toLowerCase();
  }
  const rel = path.relative(from, to);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * Resolve symlinks for a path that may not exist yet by canonicalizing the
 * nearest existing ancestor and re-appending the remaining segments. This is
 * what makes symlink escapes detectable before a write creates the file.
 */
export function canonicalize(target) {
  let current = path.resolve(target);
  const suffix = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(current) : fs.realpathSync(current);
      return suffix.length ? path.join(real, ...suffix) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(target);
}

export function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function isAccessible(target) {
  try {
    fs.accessSync(target, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function isRootUser() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

export function homeDirectory() {
  return os.homedir();
}

/**
 * Workspace priority: explicit CLI flag > saved config > MIKUHOST_WORKSPACE >
 * /root (when it exists and is accessible) > os.homedir().
 */
export function resolveWorkspaceRoot({ explicit = null, saved = null, env = process.env.MIKUHOST_WORKSPACE } = {}) {
  const candidates = [];
  if (explicit) candidates.push({ source: 'cli', value: explicit });
  if (saved) candidates.push({ source: 'config', value: saved });
  if (env && env.trim()) candidates.push({ source: 'env', value: env.trim() });
  if (process.platform !== 'win32' && fs.existsSync('/root')) candidates.push({ source: 'default-root', value: '/root' });
  candidates.push({ source: 'home', value: os.homedir() });

  const rejected = [];
  for (const candidate of candidates) {
    const expanded = expandHome(candidate.value);
    const absolute = path.resolve(expanded);
    if (!fs.existsSync(absolute)) {
      rejected.push({ ...candidate, reason: 'does not exist' });
      continue;
    }
    if (!isDirectory(absolute)) {
      rejected.push({ ...candidate, reason: 'not a directory' });
      continue;
    }
    if (!isAccessible(absolute)) {
      rejected.push({ ...candidate, reason: 'not readable/executable' });
      continue;
    }
    const real = canonicalize(absolute);
    return { root: real, source: candidate.source, rejected };
  }
  throw new WorkspaceError(
    `No accessible workspace found. Tried: ${candidates.map((c) => c.value).join(', ')}`,
    'NO_WORKSPACE',
  );
}

export function expandHome(input) {
  const value = String(input ?? '').trim();
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export class Workspace {
  constructor(root, { focus = null, caseInsensitive = process.platform === 'win32' } = {}) {
    if (!root) throw new WorkspaceError('Workspace root is required.', 'NO_WORKSPACE');
    this.caseInsensitive = caseInsensitive;
    this.root = canonicalize(expandHome(root));
    if (!isDirectory(this.root)) {
      throw new WorkspaceError(`Workspace is not a directory: ${this.root}`, 'INVALID_WORKSPACE');
    }
    this._focus = null;
    if (focus) this.setFocus(focus);
  }

  get limits() {
    return LIMITS;
  }

  get displayRoot() {
    return this.root;
  }

  /** Project focus only narrows where relative tool paths resolve; it is not a sandbox. */
  setFocus(target) {
    if (!target) {
      this._focus = null;
      return null;
    }
    const resolved = this.resolve(target, { mustExist: false });
    if (!isDirectory(resolved)) throw new WorkspaceError(`Project not found: ${target}`, 'INVALID_FOCUS');
    this._focus = resolved;
    return resolved;
  }

  get focus() {
    return this._focus ?? this.root;
  }

  /** Focused project path, or null when the workspace root is in focus. */
  get focusedPath() {
    return this._focus;
  }

  /** Directory that relative tool paths resolve against. */
  get baseDir() {
    return this.focus;
  }

  resolve(input = '.', { base = null, mustExist = false } = {}) {
    const raw = String(input ?? '.').trim() || '.';
    if (raw.includes('\u0000')) throw new WorkspaceError('Path contains a NUL byte.', 'INVALID_PATH');
    const rootReal = canonicalize(this.root);
    const baseDir = base ? this.resolve(base, { mustExist: true }) : this.baseDir;
    const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(baseDir, raw);
    const real = canonicalize(absolute);

    if (!isPathInside(rootReal, real, { caseInsensitive: this.caseInsensitive })) {
      throw new WorkspaceError(
        `Path escapes the workspace: ${raw} -> ${real} (workspace: ${rootReal})`,
        'PATH_ESCAPE',
      );
    }
    if (mustExist && !fs.existsSync(real)) {
      throw new WorkspaceError(`No such file or directory: ${raw}`, 'ENOENT');
    }
    return real;
  }

  /** True when the canonical path is inside the workspace (does not throw). */
  contains(candidate) {
    try {
      const real = canonicalize(candidate);
      return isPathInside(canonicalize(this.root), real, { caseInsensitive: this.caseInsensitive });
    } catch {
      return false;
    }
  }

  /** Human-friendly path for display (relative to workspace where possible). */
  display(target) {
    const resolved = path.isAbsolute(target) ? target : path.resolve(this.root, target);
    const rel = path.relative(this.root, resolved);
    if (rel === '') return '/';
    if (rel.startsWith('..')) return resolved;
    return `/${rel.split(path.sep).join('/')}`;
  }
}

/** Use as the single global workspace accessor in a process (CLI + TUI). */
let current = null;
export function setCurrentWorkspace(workspace) {
  current = workspace;
  return current;
}
export function getCurrentWorkspace() {
  return current;
}
