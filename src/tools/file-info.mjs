import fs from 'node:fs';
import path from 'node:path';
import { resolveToolPath, languageFor, relativeInside, formatBytes, ToolError } from './util.mjs';
import { classifySensitive } from '../security/sensitive-files.mjs';

export const fileInfoTool = {
  name: 'file_info',
  description: 'Show metadata for a path: type, size, permissions, modification time, symlink target, detected language and whether it is treated as sensitive.',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File or directory path.', minLength: 1 },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const absolute = resolveToolPath(ctx, input.path, { mustExist: true });
    let lstat;
    try {
      lstat = fs.lstatSync(absolute);
    } catch (error) {
      throw new ToolError(`Cannot stat ${input.path}: ${error.message}`, error.code ?? 'STAT_FAILED');
    }
    const stat = lstat.isSymbolicLink() ? fs.statSync(absolute) : lstat;
    const rel = relativeInside(ctx.workspace, absolute);
    const sensitive = classifySensitive(absolute);
    const mode = (stat.mode & 0o777).toString(8).padStart(3, '0');

    const info = {
      path: rel,
      absolute,
      type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      size_bytes: stat.size,
      size: formatBytes(stat.size),
      mode,
      modified: new Date(stat.mtimeMs).toISOString(),
      created: new Date(stat.birthtimeMs || stat.ctimeMs).toISOString(),
      language: stat.isFile() ? languageFor(absolute) : null,
      symlink: lstat.isSymbolicLink() ? fs.readlinkSync(absolute) : null,
      sensitive: sensitive.sensitive,
      sensitive_reason: sensitive.reason,
    };

    ctx.activity(`Inspected ${rel}`);
    const lines = Object.entries(info)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `${key}: ${value}`);

    return {
      output: lines.join('\n'),
      meta: { ...info, kind: path.basename(absolute) },
      display: { title: rel, detail: `${info.type} · ${info.size}` },
    };
  },
};
