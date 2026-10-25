import fs from 'node:fs';
import path from 'node:path';
import { resolveToolPath, readTextFile, relativeInside, formatBytes, ToolError } from './util.mjs';
import { diffLines } from '../util/diff.mjs';

export const writeFileTool = {
  name: 'write_file',
  description:
    'Overwrite or create a text file inside the workspace. Shows a diff and requires approval unless file writes are set to allow. Parent directories are created when create_directories is true.',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Target file path.', minLength: 1 },
      content: { type: 'string', description: 'Full new file content.' },
      create_directories: { type: 'boolean', description: 'Create missing parent directories (default true).' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const absolute = resolveToolPath(ctx, input.path, { mustExist: false });
    const content = String(input.content ?? '');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > ctx.limits.maxWriteBytes) {
      throw new ToolError(`Content is ${formatBytes(bytes)}; the write limit is ${formatBytes(ctx.limits.maxWriteBytes)}.`, 'TOO_LARGE');
    }
    if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
      throw new ToolError(`${input.path} is a directory.`, 'IS_DIRECTORY');
    }

    const exists = fs.existsSync(absolute);
    let diff = null;
    if (exists) {
      try {
        const { text: previous } = readTextFile(absolute, { maxBytes: ctx.limits.maxWriteBytes });
        diff = diffLines(previous, content, { context: 2 });
      } catch {
        diff = { text: '… existing file could not be read for diff (binary, too large or unreadable)', added: null, removed: null };
      }
    }
    const preview = content.split('\n').slice(0, 40).join('\n');
    const addedLines = diff?.added ?? content.split('\n').length;

    await ctx.authorizeWrite(absolute, {
      creating: !exists,
      diff: diff?.text ?? null,
      contentPreview: preview,
      summary: exists ? `overwrite ${relativeInside(ctx.workspace, absolute)}` : `create ${relativeInside(ctx.workspace, absolute)}`,
    });

    const directory = path.dirname(absolute);
    if (!fs.existsSync(directory)) {
      if (input.create_directories === false) {
        throw new ToolError(`Parent directory does not exist: ${relativeInside(ctx.workspace, directory)}`, 'ENOENT');
      }
      fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    }

    if (ctx.signal?.aborted) throw new ToolError('Operation cancelled.', 'ABORTED');
    fs.writeFileSync(absolute, content, 'utf8');
    ctx.activity(`${exists ? 'Updated' : 'Created'} ${relativeInside(ctx.workspace, absolute)}`);

    const rel = relativeInside(ctx.workspace, absolute);
    return {
      output: `Wrote ${bytes} bytes to ${rel}${exists ? ' (overwritten)' : ' (new file)'}.`,
      meta: { path: rel, bytes, created: !exists, addedLines, removedLines: diff?.removed ?? 0 },
      display: { title: rel, detail: exists ? `overwritten · +${addedLines} lines` : `created · ${content.split('\n').length} lines` },
    };
  },
};
