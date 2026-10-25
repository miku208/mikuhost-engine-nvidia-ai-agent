import fs from 'node:fs';
import path from 'node:path';
import { resolveToolPath, walkFiles, readTextFile, globToRegExp, relativeInside, ToolError } from './util.mjs';
import { classifySensitive } from '../security/sensitive-files.mjs';

export const searchTextTool = {
  name: 'search_text',
  description:
    'Search file contents for a plain-text or regular-expression query. Skips binaries, dependency directories and sensitive files (.env, keys) unless a sensitive file is explicitly targeted. Returns file:line matches.',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text or regular expression to find (case-insensitive by default).', minLength: 1 },
      path: { type: 'string', description: 'File or directory to search (default: workspace/focused project).' },
      glob: { type: 'string', description: 'Optional file filter, e.g. "*.js" or "**/*.mjs".' },
      case_sensitive: { type: 'boolean', description: 'Match case exactly (default false).' },
      regex: { type: 'boolean', description: 'Treat query as a JavaScript regular expression.' },
      max_results: { type: 'integer', minimum: 1, maximum: 300, description: 'Maximum matching lines (default 50).' },
      context_lines: { type: 'integer', minimum: 0, maximum: 3, description: 'Include N lines of context around each match.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const root = resolveToolPath(ctx, input.path ?? '.', { mustExist: true });
    const maxResults = Math.min(300, Math.max(1, Number(input.max_results) || 50));
    const contextLines = Math.min(3, Math.max(0, Number(input.context_lines) || 0));
    const caseSensitive = Boolean(input.case_sensitive);
    const flags = caseSensitive ? '' : 'i';

    let matcher;
    if (input.regex) {
      try {
        matcher = new RegExp(input.query, flags);
      } catch (error) {
        throw new ToolError(`Invalid regular expression: ${error.message}`, 'INVALID_REGEX');
      }
    } else {
      const needle = caseSensitive ? input.query : input.query.toLowerCase();
      matcher = {
        test: (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle),
      };
    }

    const stat = fs.statSync(root);
    const isFile = stat.isFile();
    let files;
    let scanTruncated = false;

    if (isFile) {
      const classification = classifySensitive(root);
      if (classification.sensitive) {
        await ctx.authorizeRead(root, { reason: classification.reason });
      }
      files = [root];
    } else {
      const globFilter = input.glob ? globToRegExp(input.glob) : null;
      const walked = walkFiles(root, {
        maxFiles: ctx.limits.maxSearchFiles,
        includeHidden: false,
        signal: ctx.signal,
      });
      scanTruncated = walked.truncated;
      files = walked.files.filter((file) => {
        if (classifySensitive(file).sensitive) return false;
        if (!globFilter) return true;
        const rel = path.relative(root, file).split(path.sep).join('/');
        return globFilter.test(rel) || globFilter.test(path.basename(file)) || globFilter.test(`**/${rel}`);
      });
    }

    const results = [];
    let filesScanned = 0;
    let filesSkipped = 0;
    let limitReached = false;

    for (const file of files) {
      if (results.length >= maxResults) {
        limitReached = true;
        break;
      }
      let text;
      try {
        if (fs.statSync(file).size > ctx.limits.maxSearchFileBytes) {
          filesSkipped += 1;
          continue;
        }
        ({ text } = readTextFile(file, { maxBytes: ctx.limits.maxSearchFileBytes }));
      } catch {
        filesSkipped += 1;
        continue;
      }
      filesScanned += 1;
      const lines = text.split('\n');
      const rel = relativeInside(ctx.workspace, file);
      const printed = new Set();
      for (let index = 0; index < lines.length; index += 1) {
        if (!matcher.test(lines[index])) continue;
        const from = Math.max(0, index - contextLines);
        const to = Math.min(lines.length - 1, index + contextLines);
        for (let cursor = from; cursor <= to; cursor += 1) {
          if (printed.has(cursor)) continue;
          printed.add(cursor);
          const marker = cursor === index ? ':' : '-';
          results.push(`${rel}${marker}${cursor + 1}${marker} ${lines[cursor].slice(0, 400)}`);
          if (results.length >= maxResults) {
            limitReached = true;
            break;
          }
        }
        if (limitReached) break;
      }
      if (limitReached) break;
    }

    ctx.activity(`Searched text for ${input.query} (${results.length} matches in ${filesScanned} files)`);
    const summary = [
      `Query: ${input.query}${input.regex ? ' (regex)' : ''}`,
      `Matches: ${results.length}${limitReached ? ` (limit ${maxResults} reached)` : ''}`,
      `Files scanned: ${filesScanned}${filesSkipped ? ` · skipped: ${filesSkipped}` : ''}${scanTruncated ? ' · scan truncated' : ''}`,
      '',
    ];
    const output = results.length ? [...summary, ...results].join('\n') : [...summary, 'No matches found.'].join('\n');

    return {
      output,
      meta: { matches: results.length, filesScanned, truncated: limitReached || scanTruncated },
      display: { title: `search_text ${input.query}`, detail: `${results.length} matches` },
    };
  },
};
