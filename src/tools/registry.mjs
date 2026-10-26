import { validateSchema, ToolValidationError } from './schema.mjs';
import { ToolError, truncateOutput, relativeInside } from './util.mjs';
import { LIMITS } from '../security/workspace.mjs';
import { evaluateFileRead, evaluateFileWrite } from '../security/permissions.mjs';
import { readFileTool } from './read-file.mjs';
import { listDirectoryTool } from './list-directory.mjs';
import { searchFilesTool } from './search-files.mjs';
import { searchTextTool } from './search-text.mjs';
import { fileInfoTool } from './file-info.mjs';
import { writeFileTool } from './write-file.mjs';
import { editFileTool } from './edit-file.mjs';
import { createFileTool } from './create-file.mjs';
import { runCommandTool } from './run-command.mjs';

const ALIASES = {
  readfile: 'read_file',
  read: 'read_file',
  cat: 'read_file',
  listdirectory: 'list_directory',
  listdir: 'list_directory',
  ls: 'list_directory',
  searchfiles: 'search_files',
  findfiles: 'search_files',
  glob: 'search_files',
  searchtext: 'search_text',
  grep: 'search_text',
  search: 'search_text',
  fileinfo: 'file_info',
  stat: 'file_info',
  writefile: 'write_file',
  editfile: 'edit_file',
  createfile: 'create_file',
  runcommand: 'run_command',
  run: 'run_command',
  shell: 'run_command',
  exec: 'run_command',
  bash: 'run_command',
};

export const MAX_TOOL_OUTPUT_CHARS = 60_000;

export class ToolRegistry {
  constructor({
    workspace,
    config,
    requestApproval = null,
    onActivity = null,
    isRootUser = false,
    session = null,
    history = null,
  } = {}) {
    this.workspace = workspace;
    this.history = history;
    this.config = config;
    this.requestApproval = requestApproval;
    this.onActivity = onActivity;
    this.isRootUser = isRootUser;
    this.session = session;
    this.tools = new Map();
    for (const tool of [
      listDirectoryTool,
      readFileTool,
      searchFilesTool,
      searchTextTool,
      fileInfoTool,
      writeFileTool,
      editFileTool,
      createFileTool,
      runCommandTool,
    ]) {
      this.register(tool);
    }
  }

  register(tool) {
    if (!tool?.name) throw new Error('Tool requires a name');
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name) {
    const key = String(name ?? '').trim();
    if (this.tools.has(key)) return this.tools.get(key);
    const normalized = key.toLowerCase().replace(/[\s-]/g, '');
    const alias = ALIASES[normalized];
    if (alias && this.tools.has(alias)) return this.tools.get(alias);
    return null;
  }

  list() {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      permission: tool.permission ?? 'read',
    }));
  }

  names() {
    return Array.from(this.tools.keys());
  }

  /** OpenAI-compatible tool definitions. */
  definitions() {
    return Array.from(this.tools.values()).map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  context({ signal } = {}) {
    const permissions = this.config?.get?.().permissions ?? { shell: 'ask', fileWrite: 'ask', sensitiveRead: 'ask' };
    const ctx = {
      workspace: this.workspace,
      config: this.config,
      limits: LIMITS,
      signal,
      permissions,
      isRootUser: this.isRootUser,
      session: this.session,
      activity: (message) => this.onActivity?.(message),
      requestApproval: async (request) => {
        if (!this.requestApproval) return false;
        return Boolean(await this.requestApproval(request));
      },
      authorizeRead: async (absPath, extra = {}) => {
        const decision = evaluateFileRead({ target: absPath, mode: permissions.sensitiveRead });
        if (!decision.requiresApproval) return true;
        const approved = await ctx.requestApproval({
          kind: 'file-read',
          target: relativeInside(this.workspace, absPath),
          absolute: absPath,
          reason: decision.reason,
          sensitive: true,
          ...extra,
        });
        if (!approved) {
          throw new ToolError(
            `Permission denied for reading ${relativeInside(this.workspace, absPath)} (sensitive file). Ask the user to approve or choose another file.`,
            'PERMISSION_DENIED',
          );
        }
        return true;
      },
      // Snapshot the pre-edit version so /undo can restore it. Best effort:
      // a failed snapshot must never block the write itself.
      recordFileSnapshot: ({ absolute, tool = 'write', previous = null, next = null }) => {
        if (!this.history) return null;
        try {
          return this.history.record({
            sessionId: this.session?.id ?? null,
            workspace: this.workspace.root,
            absolute,
            relPath: relativeInside(this.workspace, absolute),
            tool,
            previous,
            next,
          });
        } catch {
          return null;
        }
      },
      authorizeWrite: async (absPath, { diff = null, creating = false, contentPreview = null } = {}) => {
        const decision = evaluateFileWrite({ target: absPath, mode: permissions.fileWrite });
        if (!decision.requiresApproval) return true;
        const approved = await ctx.requestApproval({
          kind: creating ? 'file-create' : 'file-write',
          target: relativeInside(this.workspace, absPath),
          absolute: absPath,
          diff,
          contentPreview,
          sensitive: decision.sensitive,
          reason: decision.reason,
        });
        if (!approved) {
          throw new ToolError(
            `Permission denied: the user did not approve writing ${relativeInside(this.workspace, absPath)}.`,
            'PERMISSION_DENIED',
          );
        }
        return true;
      },
    };
    return ctx;
  }

  /**
   * Validate and execute a tool. Always resolves with a structured result so
   * the agent can feed failures back to the model instead of crashing.
   */
  async execute(name, input, { signal } = {}) {
    const startedAt = Date.now();
    const tool = this.get(name);
    if (!tool) {
      return {
        ok: false,
        toolName: name,
        error: `Unknown tool: ${name}. Available tools: ${this.names().join(', ')}`,
        errorCode: 'UNKNOWN_TOOL',
        durationMs: Date.now() - startedAt,
      };
    }

    const args = input && typeof input === 'object' ? input : {};
    const issues = validateSchema(tool.parameters, args);
    if (issues.length) {
      const error = new ToolValidationError(`Invalid input for ${tool.name}: ${issues.join('; ')}`, issues);
      return {
        ok: false,
        toolName: tool.name,
        error: error.message,
        errorCode: error.code,
        issues,
        durationMs: Date.now() - startedAt,
      };
    }

    const ctx = this.context({ signal });
    try {
      const result = await tool.run(args, ctx);
      const rawOutput = typeof result === 'string' ? result : result?.output ?? '';
      const { text, truncated } = truncateOutput(rawOutput, MAX_TOOL_OUTPUT_CHARS);
      return {
        ok: true,
        toolName: tool.name,
        output: text,
        truncated,
        meta: (typeof result === 'object' ? result?.meta : null) ?? null,
        display: (typeof result === 'object' ? result?.display : null) ?? null,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const isTool = error instanceof ToolError || error instanceof ToolValidationError;
      return {
        ok: false,
        toolName: tool.name,
        error: error?.message ?? String(error),
        errorCode: isTool ? error.code : error?.code ?? 'TOOL_FAILED',
        durationMs: Date.now() - startedAt,
      };
    }
  }
}
