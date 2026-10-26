// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, WorkspaceError, canonicalize, isPathInside } from '../security/workspace.mjs';
import { IGNORED_DIRS } from '../projects/scanner.mjs';

export class ToolError extends Error {
  constructor(message, code = 'TOOL_ERROR') {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

export function resolveToolPath(ctx, input, { mustExist = false, allowDirectory = true } = {}) {
  const raw = typeof input === 'string' && input.trim() ? input.trim() : '.';
  try {
    const resolved = ctx.workspace.resolve(raw, { mustExist });
    if (!allowDirectory) {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) throw new ToolError(`${raw} is a directory, not a file.`, 'IS_DIRECTORY');
    }
    return resolved;
  } catch (error) {
    if (error instanceof WorkspaceError) throw new ToolError(error.message, error.code);
    throw error;
  }
}

export function isBinaryBuffer(buffer) {
  const sample = buffer.subarray(0, 4096);
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return true;
  }
  return false;
}

export function readTextFile(absPath, { maxBytes = LIMITS.maxReadBytes } = {}) {
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) throw new ToolError('Path is not a regular file.', 'NOT_A_FILE');
  if (stat.size > maxBytes) {
    throw new ToolError(
      `File is ${stat.size} bytes, larger than the ${maxBytes} byte read limit. Use start_line/end_line on a smaller file or increase the limit in config.`,
      'TOO_LARGE',
    );
  }
  const buffer = fs.readFileSync(absPath);
  if (isBinaryBuffer(buffer)) throw new ToolError('File appears to be binary and cannot be read as text.', 'BINARY_FILE');
  return { text: buffer.toString('utf8').replace(/^\uFEFF/, ''), stat };
}

export function sliceLines(text, startLine, endLine) {
  const lines = text.split('\n');
  const total = lines.length;
  const start = Math.max(1, Number(startLine) || 1);
  const end = Math.min(total, Number(endLine) || total);
  if (start > total) {
    return { text: '', total, start, end: start - 1, truncated: false };
  }
  const slice = lines.slice(start - 1, end);
  return {
    text: slice.join('\n'),
    total,
    start,
    end: Math.max(start - 1, end),
    truncated: start > 1 || end < total,
  };
}

export function numberLines(text, startLine = 1) {
  return String(text)
    .split('\n')
    .map((line, index) => `${String(startLine + index).padStart(4, ' ')}│ ${line}`)
    .join('\n');
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function languageFor(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase();
  const map = {
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript', '.json': 'json', '.md': 'markdown',
    '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.php': 'php',
    '.java': 'java', '.kt': 'kotlin', '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
    '.css': 'css', '.scss': 'scss', '.html': 'html', '.yml': 'yaml', '.yaml': 'yaml',
    '.toml': 'toml', '.sql': 'sql', '.xml': 'xml', '.env': 'dotenv',
  };
  return map[ext] ?? null;
}

/**
 * Walk files under a directory, pruning dependency/build directories and
 * enforcing bounds. Returns absolute paths.
 */
export function walkFiles(root, {
  maxFiles = LIMITS.maxSearchFiles,
  maxDepth = 12,
  maxFileBytes = LIMITS.maxSearchFileBytes,
  includeHidden = false,
  signal = null,
} = {}) {
  const files = [];
  const queue = [{ dir: root, depth: 0 }];
  const rootReal = canonicalize(root);
  let truncated = false;

  while (queue.length) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    if (signal?.aborted) throw new ToolError('Search cancelled.', 'ABORTED');
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (!includeHidden && entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 <= maxDepth) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (entry.isSymbolicLink()) {
        // Only follow symlinks that resolve inside the workspace.
        try {
          const real = canonicalize(full);
          if (!isPathInside(rootReal, real) && !isPathInside(canonicalize(root), real)) continue;
          const stat = fs.statSync(real);
          if (stat.isDirectory()) {
            if (depth + 1 <= maxDepth) queue.push({ dir: real, depth: depth + 1 });
            continue;
          }
          if (!stat.isFile() || stat.size > maxFileBytes) continue;
          files.push(real);
        } catch {
          /* broken symlink */
        }
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.size > maxFileBytes) continue;
        files.push(full);
      } catch {
        /* ignore */
      }
    }
  }
  return { files, truncated };
}

/** Convert a simple glob into a RegExp (** crosses directories, * does not). */
export function globToRegExp(glob) {
  const pattern = String(glob ?? '').trim();
  if (!pattern) return null;
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += '$';
  try {
    return new RegExp(out);
  } catch {
    return null;
  }
}

export function relativeInside(workspace, absPath) {
  return path.relative(workspace.root, absPath).split(path.sep).join('/') || '.';
}

/** Truncate command output while keeping both head and tail visible. */
export function truncateOutput(text, maxBytes = LIMITS.maxCommandOutputBytes) {
  const value = String(text ?? '');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
  const lines = value.split('\n');
  const head = lines.slice(0, Math.max(1, Math.floor(lines.length * 0.6))).join('\n');
  const tail = lines.slice(-Math.max(1, Math.floor(lines.length * 0.3))).join('\n');
  return {
    text: `${head}\n… output truncated (${value.length} chars) …\n${tail}`,
    truncated: true,
  };
}
