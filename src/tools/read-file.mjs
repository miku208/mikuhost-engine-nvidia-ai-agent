import { resolveToolPath, readTextFile, sliceLines, numberLines, relativeInside } from './util.mjs';
import { classifySensitive } from '../security/sensitive-files.mjs';

export const readFileTool = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file inside the workspace. Supports optional 1-based line range. Sensitive files (.env, private keys, credentials) require user approval before their contents are returned.',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace or focused project, or an absolute path inside the workspace.' },
      start_line: { type: 'integer', minimum: 1, description: 'First line to return (1-based, optional).' },
      end_line: { type: 'integer', minimum: 1, description: 'Last line to return (inclusive, optional).' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const absolute = resolveToolPath(ctx, input.path, { mustExist: true, allowDirectory: false });
    const sensitive = classifySensitive(absolute);
    await ctx.authorizeRead(absolute, { reason: sensitive.reason });
    const { text, stat } = readTextFile(absolute);
    const slice = sliceLines(text, input.start_line, input.end_line);
    const rel = relativeInside(ctx.workspace, absolute);
    ctx.activity(`Read ${rel}${slice.truncated ? ` (lines ${slice.start}-${slice.end})` : ''}`);

    const header = [
      `<file path="${rel}" lines="${slice.start}-${slice.end}" total_lines="${slice.total}" bytes="${stat.size}">`,
      numberLines(slice.text, slice.start),
      '</file>',
    ].join('\n');

    return {
      output: header,
      meta: {
        path: rel,
        bytes: stat.size,
        totalLines: slice.total,
        lines: `${slice.start}-${slice.end}`,
        sensitive: sensitive.sensitive,
      },
      display: { title: rel, detail: `${slice.total} lines · ${stat.size} bytes` },
    };
  },
};

