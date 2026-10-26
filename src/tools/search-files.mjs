// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import path from 'node:path';
import { resolveToolPath, walkFiles, globToRegExp, relativeInside } from './util.mjs';

export const searchFilesTool = {
  name: 'search_files',
  description:
    'Find files by name/glob under a directory. Examples: pattern "*.js", "**/package.json", "server.*". Dependency and build directories are skipped.',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern matched against the path relative to the search directory and the file name.', minLength: 1 },
      path: { type: 'string', description: 'Directory to search (default: workspace/focused project).' },
      max_results: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum matches (default 100).' },
      include_hidden: { type: 'boolean', description: 'Include dotfiles (default false).' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const root = resolveToolPath(ctx, input.path ?? '.', { mustExist: true });
    const maxResults = Math.min(500, Math.max(1, Number(input.max_results) || 100));
    const regex = globToRegExp(input.pattern);
    if (!regex) {
      return { output: `Invalid glob pattern: ${input.pattern}`, meta: { matches: 0, invalid: true } };
    }
    const loose = globToRegExp(input.pattern.includes('/') ? `**/${input.pattern.replace(/^\*\*\//, '')}` : `**/${input.pattern}`);

    const { files, truncated } = walkFiles(root, {
      maxFiles: ctx.limits.maxSearchFiles,
      includeHidden: Boolean(input.include_hidden),
      signal: ctx.signal,
    });

    const matches = [];
    for (const file of files) {
      if (matches.length >= maxResults) break;
      const rel = path.relative(root, file).split(path.sep).join('/');
      const name = path.basename(file);
      if (regex.test(rel) || regex.test(name) || (loose && loose.test(rel))) {
        matches.push(relativeInside(ctx.workspace, file));
      }
    }

    ctx.activity(`Searched files for ${input.pattern} (${matches.length} matches)`);
    const lines = [
      `Pattern: ${input.pattern}`,
      `Matches: ${matches.length}${matches.length >= maxResults ? ` (limit ${maxResults} reached)` : ''}${truncated ? ' — file scan truncated' : ''}`,
      '',
      ...matches,
    ];
    return {
      output: lines.join('\n'),
      meta: { matches: matches.length, truncated },
      display: { title: `search_files ${input.pattern}`, detail: `${matches.length} matches` },
    };
  },
};
