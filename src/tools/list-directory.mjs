// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import fs from 'node:fs';
import path from 'node:path';
import { resolveToolPath, relativeInside, formatBytes, ToolError } from './util.mjs';
import { IGNORED_DIRS } from '../projects/scanner.mjs';
import { isPathInside } from '../security/workspace.mjs';

export const listDirectoryTool = {
  name: 'list_directory',
  description:
    'List files and directories inside the workspace. Dependency/build directories (node_modules, .git, dist, build, coverage, vendor, ...) are always skipped. Use depth 1-3.',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path (default: workspace or focused project root).' },
      depth: { type: 'integer', minimum: 1, maximum: 3, description: 'Recursion depth (default 1).' },
      include_hidden: { type: 'boolean', description: 'Include dotfiles (default false).' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum entries to return (default 200).' },
    },
    required: [],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const root = resolveToolPath(ctx, input.path ?? '.', { mustExist: true });
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) throw new ToolError(`${input.path ?? '.'} is not a directory.`, 'NOT_A_DIRECTORY');

    const depth = Math.min(3, Math.max(1, Number(input.depth) || 1));
    const limit = Math.min(500, Math.max(1, Number(input.limit) || 200));
    const includeHidden = Boolean(input.include_hidden);
    const lines = [];
    let entries = 0;
    let truncated = false;
    let skipped = 0;

    const walk = (dir, level, prefix) => {
      if (entries >= limit) {
        truncated = true;
        return;
      }
      let dirents;
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        lines.push(`${prefix}[unreadable: ${error.code ?? error.message}]`);
        return;
      }
      dirents.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const entry of dirents) {
        if (entries >= limit) {
          truncated = true;
          return;
        }
        if (!includeHidden && entry.name.startsWith('.')) {
          skipped += 1;
          continue;
        }
        if (IGNORED_DIRS.has(entry.name)) {
          skipped += 1;
          continue;
        }
        const full = path.join(dir, entry.name);
        const rel = relativeInside(ctx.workspace, full);
        if (!isPathInside(ctx.workspace.root, full)) {
          skipped += 1;
          continue;
        }
        entries += 1;
        if (entry.isSymbolicLink()) {
          lines.push(`${prefix}${entry.name} -> symlink (not followed)`);
          continue;
        }
        if (entry.isDirectory()) {
          lines.push(`${prefix}${entry.name}/`);
          if (level < depth) walk(full, level + 1, `${prefix}  `);
          continue;
        }
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* ignore */
        }
        lines.push(`${prefix}${entry.name}  (${formatBytes(size)})`);
      }
    };

    walk(root, 1, '');

    const relRoot = relativeInside(ctx.workspace, root);
    ctx.activity(`Listed ${relRoot} (${entries} entries)`);
    const header = `Directory: ${relRoot}${truncated ? ` — showing first ${limit} entries` : ''}`;
    const footer = skipped ? `\n… ${skipped} ignored entries (dependencies, hidden files or outside workspace)` : '';

    return {
      output: `${[header, ...lines].join('\n')}${footer}`,
      meta: { path: relRoot, entries, truncated, skipped },
      display: { title: relRoot, detail: `${entries} entries${truncated ? ' (truncated)' : ''}` },
    };
  },
};
