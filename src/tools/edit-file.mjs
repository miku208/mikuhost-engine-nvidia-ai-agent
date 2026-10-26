// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import fs from 'node:fs';
import { resolveToolPath, readTextFile, relativeInside, ToolError } from './util.mjs';
import { diffLines } from '../util/diff.mjs';

export const editFileTool = {
  name: 'edit_file',
  description:
    'Replace an exact string in an existing text file. old_string must appear exactly once unless replace_all is true. Shows a diff and asks for approval. Prefer small, targeted edits over rewriting whole files.',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to edit.', minLength: 1 },
      old_string: { type: 'string', description: 'Exact text to replace (include surrounding context to keep it unique).' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const absolute = resolveToolPath(ctx, input.path, { mustExist: true, allowDirectory: false });
    const { text } = readTextFile(absolute);
    const oldString = String(input.old_string ?? '');
    const newString = String(input.new_string ?? '');

    if (!oldString) throw new ToolError('old_string must not be empty.', 'INVALID_INPUT');
    if (oldString === newString) throw new ToolError('old_string and new_string are identical; nothing to do.', 'NO_CHANGE');

    const occurrences = countOccurrences(text, oldString);
    if (occurrences === 0) {
      throw new ToolError(
        `old_string was not found in ${relativeInside(ctx.workspace, absolute)}. Re-read the file and copy the exact text (including whitespace).`,
        'NOT_FOUND',
      );
    }
    if (occurrences > 1 && !input.replace_all) {
      const sample = text.indexOf(oldString);
      const line = text.slice(0, sample).split('\n').length;
      throw new ToolError(
        `old_string appears ${occurrences} times (first at line ${line}); add surrounding context or set replace_all=true.`,
        'AMBIGUOUS_MATCH',
      );
    }

    const updated = input.replace_all ? text.split(oldString).join(newString) : replaceFirst(text, oldString, newString);
    const bytes = Buffer.byteLength(updated, 'utf8');
    if (bytes > ctx.limits.maxWriteBytes) {
      throw new ToolError(`Resulting file would be ${bytes} bytes, over the write limit.`, 'TOO_LARGE');
    }

    const diff = diffLines(text, updated, { context: 3 });
    await ctx.authorizeWrite(absolute, {
      diff: diff.text,
      creating: false,
      summary: `edit ${relativeInside(ctx.workspace, absolute)}`,
    });

    if (ctx.signal?.aborted) throw new ToolError('Operation cancelled.', 'ABORTED');
    ctx.recordFileSnapshot?.({ absolute, tool: 'edit_file', previous: text, next: updated });
    fs.writeFileSync(absolute, updated, 'utf8');
    const rel = relativeInside(ctx.workspace, absolute);
    ctx.activity(`Edited ${rel} (${occurrences} ${occurrences === 1 ? 'change' : 'changes'})`);

    return {
      output: `Applied edit to ${rel}: +${diff.added} / -${diff.removed} lines (${occurrences} occurrence${occurrences === 1 ? '' : 's'}).\n${diff.text}`,
      meta: { path: rel, occurrences, added: diff.added, removed: diff.removed },
      display: { title: rel, detail: `+${diff.added} / -${diff.removed} lines` },
    };
  },
};

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
    if (count > 1000) break;
  }
  return count;
}

function replaceFirst(haystack, needle, replacement) {
  const index = haystack.indexOf(needle);
  if (index === -1) return haystack;
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
}
