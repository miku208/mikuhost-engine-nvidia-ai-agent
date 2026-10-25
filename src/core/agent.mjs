import { NvidiaProvider } from '../providers/nvidia.mjs';
import { ProviderError, ERROR_CODES } from '../providers/errors.mjs';
import { ToolRegistry } from '../tools/registry.mjs';
import { ModelRegistry } from '../models/registry.mjs';
import { scanProjects, findProject } from '../projects/scanner.mjs';
import { buildSystemPrompt, historyToApi, compactMessages } from './context.mjs';
import { runAgentLoop } from './agent-loop.mjs';
import { PHASES } from './events.mjs';
import { isRootUser } from '../security/workspace.mjs';
import { classifySensitive } from '../security/sensitive-files.mjs';
import { redactSecrets } from '../util/text.mjs';
import { attachmentMeta, composePromptWithAttachments } from '../paste/attachments.mjs';
import { reasoningSettings } from '../reasoning/parser.mjs';

export class AgentSetupError extends Error {
  constructor(message, code = 'SETUP_REQUIRED') {
    super(message);
    this.name = 'AgentSetupError';
    this.code = code;
  }
}

export class AgentRuntime {
  constructor({
    config,
    workspace,
    credentials,
    session,
    providerFactory = null,
    approvalHandler = null,
    onEvent = () => {},
    isRoot = null,
  } = {}) {
    this.config = config;
    this.workspace = workspace;
    this.credentials = credentials;
    this.session = session;
    this.providerFactory = providerFactory;
    this.approvalHandler = approvalHandler;
    this.onEvent = onEvent;
    this.isRoot = isRoot ?? isRootUser();
    this.models = new ModelRegistry({
      userModels: config?.get?.().models ?? [],
      defaultModel: config?.get?.().defaultModel,
    });
    this.projectScan = null;
    /** Model id -> detected tool mode ('native' | 'fallback' | 'chat'). */
    this.toolModes = new Map();
  }

  setApprovalHandler(handler) {
    this.approvalHandler = handler;
  }

  setEventHandler(handler) {
    this.onEvent = handler ?? (() => {});
  }

  emit(event) {
    try {
      this.onEvent(event);
    } catch {
      /* listener errors must not break the agent */
    }
  }

  get activeModel() {
    const sessionModel = this.session?.session?.model;
    const configured = this.config?.get?.().defaultModel;
    return sessionModel || configured || this.models.defaultModel;
  }

  modelName(id = this.activeModel) {
    return this.models.displayName(id);
  }

  requireCredential() {
    const entry = this.credentials?.activeEntry?.();
    if (!entry) {
      throw new AgentSetupError(
        'No NVIDIA API key configured. Run `mikuhost` to complete first-time setup, or add a key with `/keys`.',
        'NO_CREDENTIALS',
      );
    }
    return entry;
  }

  providerFor(entry) {
    if (this.providerFactory) return this.providerFactory(entry);
    return new NvidiaProvider({
      baseUrl: this.config.baseUrl,
      apiKey: entry.key,
      timeoutMs: 180_000,
    });
  }

  scanProjects({ force = false } = {}) {
    if (!this.projectScan || force) {
      this.emit({ type: 'status', message: 'Scanning workspace for projects…' });
      this.projectScan = scanProjects(this.workspace.root, {
        maxDepth: 3,
        maxProjects: 80,
        timeoutMs: 4000,
      });
      this.emit({
        type: 'status',
        message: this.projectScan.projects.length
          ? `Found ${this.projectScan.projects.length} project${this.projectScan.projects.length === 1 ? '' : 's'}`
          : 'No projects detected',
      });
    }
    return this.projectScan;
  }

  get projects() {
    return this.projectScan?.projects ?? [];
  }

  focusProject(query) {
    if (!query || ['reset', 'all', 'none', 'root'].includes(String(query).toLowerCase())) {
      this.workspace.setFocus(null);
      this.session?.setProject?.(null);
      this.emit({ type: 'status', message: 'Focused the workspace root' });
      return null;
    }
    const projects = this.scanProjects().projects;
    const project = findProject(projects, query);
    if (!project) {
      throw new AgentSetupError(
        `Project "${query}" not found. Available: ${projects.map((p) => p.relPath).join(', ') || '(none)'}`,
        'PROJECT_NOT_FOUND',
      );
    }
    this.workspace.setFocus(project.path);
    this.session?.setProject?.(project.relPath);
    this.emit({ type: 'status', message: `Focused project ${project.relPath}` });
    return project;
  }

  setModel(id) {
    const entry = this.models.byId(id);
    if (!entry) throw new AgentSetupError(`Unknown model: ${id}`, 'MODEL_NOT_FOUND');
    this.config.setValue('defaultModel', entry.id);
    this.session?.setModel?.(entry.id);
    this.emit({ type: 'status', message: `Model set to ${entry.name}` });
    return entry;
  }

  detectedToolMode(modelId) {
    return this.toolModes.get(modelId) ?? 'native';
  }

  rememberToolMode(modelId, mode) {
    if (mode) this.toolModes.set(modelId, mode);
  }

  get permissionModes() {
    return this.config?.get?.().permissions ?? { shell: 'ask', fileWrite: 'ask', sensitiveRead: 'ask' };
  }

  buildRegistry({ signal } = {}) {
    return new ToolRegistry({
      workspace: this.workspace,
      config: this.config,
      isRootUser: this.isRoot,
      session: this.session,
      requestApproval: async (request) => {
        if (!this.approvalHandler) {
          this.emit({ type: 'warning', message: 'Approval required but no interactive handler is available.' });
          return false;
        }
        this.emit({ type: 'tool-approval', request });
        this.emit({ type: 'phase', phase: PHASES.WAITING_APPROVAL });
        const approved = Boolean(await this.approvalHandler(request));
        this.emit({ type: 'phase', phase: PHASES.TOOL_EXECUTION });
        return approved;
      },
      onActivity: (message) => this.emit({ type: 'status', message }),
      signal,
    });
  }

  /** Redact secret-looking substrings from text that leaves a tool. */
  static sanitizeOutput(text) {
    return redactSecrets(text);
  }

  async send(prompt, { signal = null, attachments = [] } = {}) {
    const startedAt = Date.now();
    const entry = this.requireCredential();
    const pasted = Array.isArray(attachments) ? attachments.filter((attachment) => attachment?.content) : [];
    const displayPrompt = String(prompt ?? '').trim() || (pasted.length ? 'Pasted text' : '');
    const modelPrompt = composePromptWithAttachments(displayPrompt, pasted);
    const model = this.activeModel;
    const provider = this.providerFor(entry);
    const registry = this.buildRegistry({ signal });

    this.session.ensure({
      model,
      workspace: this.workspace.root,
      project: this.session.session?.project ?? null,
    });

    const compactionThreshold = this.config?.get?.().agent?.compactAfterMessages ?? 80;
    if (this.session.messages.length > compactionThreshold) {
      const compacted = compactMessages(this.session.messages, { threshold: compactionThreshold, keepRecent: 24 });
      if (compacted.compacted) {
        this.session.replaceMessages(compacted.messages);
        this.emit({
          type: 'warning',
          message: `Context compacted: ${compacted.removed} older messages replaced by a local summary.`,
        });
      }
    }

    const userStored = this.session.appendMessage({
      role: 'user',
      content: displayPrompt,
      meta: pasted.length ? { attachments: pasted.map(attachmentMeta) } : null,
    });
    if (this.session.session?.model !== model) this.session.setModel(model);

    const scan = this.scanProjects();
    const focus = this.workspace.focusedPath;
    const toolMode = this.detectedToolMode(model);
    const systemPrompt = buildSystemPrompt({
      workspace: this.workspace.root,
      focusProject: focus,
      projects: scan.projects,
      model,
      modelName: this.modelName(model),
      toolMode,
      toolNames: registry.names(),
      isRootUser: this.isRoot,
      shellMode: this.permissionModes.shell,
    });

    const history = this.session.messages
      .filter((message) => message.id !== userStored.id)
      .map((message) => ({ ...message }));
    const requestMessages = [
      { role: 'system', content: systemPrompt },
      ...historyToApi(history),
      { role: 'user', content: modelPrompt },
    ];

    this.emit({ type: 'phase', phase: PHASES.CONNECTING });
    this.emit({ type: 'status', message: `Connecting to NVIDIA (${this.modelName(model)})` });
    this.emit({ type: 'start', model, modelName: this.modelName(model) });

    const reasoning = reasoningSettings(this.config?.get?.() ?? {});
    const reasoningParams = this.config?.get?.().providers?.nvidia?.reasoningParams?.[model] ?? null;

    let loop;
    try {
      loop = await runAgentLoop({
        provider,
        model,
        messages: requestMessages,
        tools: registry.definitions(),
        executeTool: (name, input, opts) => registry.execute(name, input, opts),
        maxIterations: this.config?.get?.().agent?.maxIterations ?? 20,
        onEvent: (event) => this.emit(event),
        signal,
        streaming: this.config?.get?.().ui?.streaming !== false,
        toolMode,
        temperature: 0.6,
        // /reasoning off means do not capture or persist reasoning at all.
        captureReasoning: reasoning.enabled,
        // Opt-in per-model parameters only; never guessed from the model id.
        extraBody: reasoningParams,
      });
    } catch (error) {
      this.emit({
        type: 'phase',
        phase: error?.code === ERROR_CODES.ABORTED || signal?.aborted ? PHASES.CANCELLED : PHASES.ERROR,
      });
      if (error?.httpStatus) {
        this.credentials.reportFailure(entry.id, error.httpStatus);
      }
      if (error?.code === ERROR_CODES.INVALID_MODEL) {
        this.models.markUnavailable(model, error.message);
        this.emit({ type: 'warning', message: `Model unavailable for current NVIDIA credential: ${this.modelName(model)}` });
      }
      throw error;
    }

    this.credentials.touch(entry.id);
    if (loop.error?.httpStatus) this.credentials.reportFailure(entry.id, loop.error.httpStatus);
    if (loop.error?.code === ERROR_CODES.AUTH || loop.error?.code === ERROR_CODES.FORBIDDEN) {
      this.credentials.reportFailure(entry.id, loop.error.httpStatus);
    }

    this.rememberToolMode(model, loop.toolMode);
    // Attach the real turn duration to the answer that will be rendered with
    // "Completed in Ns". It is persisted with the message, so reopening the
    // session keeps the footer accurate.
    const finalAssistant = [...loop.appended]
      .reverse()
      .find((record) => record.role === 'assistant' && !record.meta?.toolCalls?.length);
    if (finalAssistant) {
      finalAssistant.meta = {
        ...(finalAssistant.meta ?? {}),
        durationMs: Date.now() - startedAt,
        completed: !loop.aborted && !loop.error,
      };
    }
    for (const record of loop.appended) {
      this.session.appendMessage({
        role: record.role,
        content: record.content,
        toolName: record.toolName ?? null,
        meta: record.meta ?? null,
      });
    }

    if (!loop.error) {
      this.emit({ type: 'status', message: 'Ready' });
    }

    return loop;
  }
}

export { classifySensitive };
