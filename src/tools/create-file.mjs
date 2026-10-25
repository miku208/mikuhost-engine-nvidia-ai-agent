import fs from 'node:fs';
import path from 'node:path';
import { resolveToolPath, relativeInside, formatBytes, ToolError } from './util.mjs';

export const createFileTool = {
  name: 'create_file',
  description: 'Create a new text file. Fails if the file already exists (use write_file/edit_file to modify existing files). Requires approval.',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'New file path.', minLength: 1 },
      content: { type: 'string', description: 'Initial file content.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const absolute = resolveToolPath(ctx, input.path, { mustExist: false });
    if (fs.existsSync(absolute)) {
      throw new ToolError(`${relativeInside(ctx.workspace, absolute)} already exists. Use write_file or edit_file instead.`, 'ALREADY_EXISTS');
    }
    const content = String(input.content ?? '');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > ctx.limits.maxWriteBytes) {
      throw new ToolError(`Content is ${formatBytes(bytes)}, over the ${formatBytes(ctx.limits.maxWriteBytes)} write limit.`, 'TOO_LARGE');
    }

    await ctx.authorizeWrite(absolute, {
      creating: true,
      diff: null,
      contentPreview: content.split('\n').slice(0, 40).join('\n'),
      summary: `create ${relativeInside(ctx.workspace, absolute)}`,
    });

    if (ctx.signal?.aborted) throw new ToolError('Operation cancelled.', 'ABORTED');
    fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o755 });
    fs.writeFileSync(absolute, content, { encoding: 'utf8', flag: 'wx' });
    const rel = relativeInside(ctx.workspace, absolute);
    ctx.activity(`Created ${rel}`);
    return {
      output: `Created ${rel} (${bytes} bytes, ${content.split('\n').length} lines).`,
      meta: { path: rel, bytes, created: true },
      display: { title: rel, detail: `${content.split('\n').length} lines` },
    };
  },
};
