// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import { ProviderError, ERROR_CODES } from '../providers/errors.mjs';
import { createProvider, providerName, resolveProviderId } from '../providers/catalog.mjs';
import { ToolRegistry } from '../tools/registry.mjs';
import { ModelRegistry } from '../models/registry.mjs';
import { scanProjects, findProject } from '../projects/scanner.mjs';
import { buildSystemPrompt, historyToApi, compactMessages, findUnfinishedTurn } from './context.mjs';
import { runAgentLoop } from './agent-loop.mjs';
import { PHASES } from './events.mjs';
import { isRootUser } from '../security/workspace.mjs';
import { classifySensitive } from '../security/sensitive-files.mjs';
import { redactSecrets } from '../util/text.mjs';
import { attachmentMeta, composePromptWithAttachments } from '../paste/attachments.mjs';
import { reasoningSettings } from '../reasoning/parser.mjs';
import { FileHistory } from '../history/file-history.mjs';

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
    history = null,
  } = {}) {
    this.config = config;
    // Pre-edit snapshots for /undo, shared with the UI through the environment.
    this.history = history ?? new FileHistory();
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
    /** Session id whose compaction was already announced, so it warns once. */
    this.compactionNoticeFor = null;
    /** Turns started by this runtime; feeds the per-turn snapshot id. */
    this.turnSeq = 0;
  }

  /**
   * A fresh id per turn. Every snapshot a turn takes carries it, so the whole
   * turn can be reverted as one unit. The timestamp keeps ids unique across
   * runs of the same session, where the counter alone would repeat.
   */
  nextTurnId() {
    this.turnSeq += 1;
    return `t_${Date.now().toString(36)}_${this.turnSeq.toString(36)}`;
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

  /** Whether at least one usable key exists for a provider. */
  providerHasKey(providerId) {
    const credentials = this.credentials;
    if (!credentials) return false;
    const id = resolveProviderId(providerId);
    if (typeof credentials.providers === 'function') return credentials.providers().includes(id);
    const active = credentials.activeEntry?.();
    if (!active) return false;
    return resolveProviderId(credentials.activeProvider ?? active.provider ?? id) === id;
  }

  /**
   * Model chosen for the next request: the session model, then the configured
   * default. A model whose provider has no key is ignored, so a session saved
   * under one service still works after switching to another service's key.
   */
  currentModelEntry() {
    const candidates = [this.session?.session?.model, this.config?.get?.().defaultModel];
    for (const candidate of candidates) {
      const entry = this.models.byId(candidate);
      if (entry && this.providerHasKey(entry.provider)) return entry;
    }
    return null;
  }

  /** Provider that serves the selected model; the active key is only a fallback. */
  get providerId() {
    const entry = this.currentModelEntry();
    if (entry) return resolveProviderId(entry.provider);
    return this.credentials?.activeProvider ?? resolveProviderId(this.config?.get?.().provider);
  }

  get providerName() {
    return providerName(this.providerId);
  }

  /** Model used for the next request. */
  get activeModel() {
    return this.currentModelEntry()?.id ?? this.models.defaultFor(this.providerId)?.id ?? null;
  }

  modelName(id = this.activeModel) {
    return this.models.displayName(id);
  }

  /**
   * Key for this request. It is validated against the model's provider, and a
   * random one is used when that provider has several eligible keys.
   */
  credentialFor(providerId = this.providerId) {
    const picked =
      this.credentials?.pickForProvider?.(providerId) ?? this.credentials?.activeEntry?.() ?? null;
    if (!picked) {
      throw new AgentSetupError(
        `No API key for ${providerName(providerId)}. Add one with /keys, or export NVIDIA_API_KEY / TOKENHARBOR_API_KEY.`,
        'NO_CREDENTIALS',
      );
    }
    this.credentials?.markUsed?.(picked.id);
    return picked;
  }

  requireCredential() {
    const entry = this.credentials?.activeEntry?.();
    if (!entry) {
      throw new AgentSetupError(
        'No API key configured. Run `mikuhost` to complete first-time setup, add a key with `/keys`, or export NVIDIA_API_KEY / TOKENHARBOR_API_KEY.',
        'NO_CREDENTIALS',
      );
    }
    return entry;
  }

  providerFor(entry) {
    if (this.providerFactory) return this.providerFactory(entry);
    // The key prefix decides the provider, so a mislabelled key still reaches
    // the service it really belongs to.
    const id = this.credentials?.providerOf?.(entry) ?? resolveProviderId(entry.provider);
    const baseUrl =
      entry.baseUrl || this.config?.baseUrlFor?.(id) || this.config?.baseUrl || null;
    return createProvider({
      provider: id,
      baseUrl,
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
    const modelProvider = resolveProviderId(entry.provider);
    if (modelProvider !== this.providerId) {
      // The key follows the model: picking a TokenHarbor model switches to the
      // TokenHarbor credential, and an NVIDIA model switches back, so the two
      // are never mixed up. The key itself is validated for that provider.
      const credential =
        this.credentials?.pickForProvider?.(modelProvider) ??
        this.credentials?.firstForProvider?.(modelProvider);
      if (!credential) {
        throw new AgentSetupError(
          `${entry.name} is served by ${providerName(modelProvider)}, but no ${providerName(modelProvider)} key is stored. Add one with /keys first.`,
          'PROVIDER_MISMATCH',
        );
      }
      this.credentials.setActive(credential.id);
    }
    this.config.setValue('provider', modelProvider);
    this.config.setValue('defaultModel', entry.id);
    this.config.setValue(`providers.${modelProvider}.defaultModel`, entry.id);
    this.session?.setModel?.(entry.id);
    this.emit({ type: 'status', message: `Model set to ${entry.name}` });
    return entry;
  }

  /**
   * Point the runtime at a provider's default model without choosing a key;
   * the keys panel uses this after the user picks a key.
   */
  useProvider(providerId) {
    const id = resolveProviderId(providerId);
    this.config.setValue('provider', id);
    const model = this.models.defaultFor(id);
    if (!model) return null;
    this.config.setValue('defaultModel', model.id);
    this.config.setValue(`providers.${id}.defaultModel`, model.id);
    this.session?.setModel?.(model.id);
    this.emit({ type: 'status', message: `Provider set to ${providerName(id)} · ${model.name}` });
    return model;
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

  buildRegistry({ signal, turnId = null } = {}) {
    return new ToolRegistry({
      workspace: this.workspace,
      config: this.config,
      isRootUser: this.isRoot,
      session: this.session,
      history: this.history,
      turnId,
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
    const pasted = Array.isArray(attachments) ? attachments.filter((attachment) => attachment?.content) : [];
    const displayPrompt = String(prompt ?? '').trim() || (pasted.length ? 'Pasted text' : '');
    return this.#runTurn({
      displayPrompt,
      modelPrompt: composePromptWithAttachments(displayPrompt, pasted),
      pasted,
      signal,
      resume: false,
      startedAt: Date.now(),
    });
  }

  /**
   * Re-run a turn that never received an answer (SSH drop, crash, Ctrl+C
   * before the first token). The pending user message is already in the
   * transcript, so it is sent as history instead of being appended twice.
   */
  async continueTurn({ signal = null } = {}) {
    const pending = findUnfinishedTurn(this.session?.messages ?? []);
    if (!pending) {
      throw new AgentSetupError('There is no unfinished turn to continue.', 'NOTHING_TO_CONTINUE');
    }
    return this.#runTurn({
      displayPrompt: null,
      modelPrompt: null,
      pasted: [],
      signal,
      resume: true,
      startedAt: Date.now(),
    });
  }

  async #runTurn({ displayPrompt, modelPrompt, pasted, signal, resume, startedAt }) {
    const model = this.activeModel;
    if (!model) {
      throw new AgentSetupError(
        `No model configured for ${this.providerName}. Choose one with /model, or add a model id to config.json → "models" with "provider": "${this.providerId}".`,
        'NO_MODEL',
      );
    }
    // The key is chosen for the model's provider, never for whatever key was
    // last selected: with several eligible keys one is picked at random.
    const entry = this.credentialFor(this.providerId);
    const providerId = this.credentials?.providerOf?.(entry) ?? this.providerId;
    const provider = this.providerFor(entry);
    const registry = this.buildRegistry({ signal, turnId: this.nextTurnId() });

    this.session.ensure({
      model,
      workspace: this.workspace.root,
      project: this.session.session?.project ?? null,
    });

    // Compaction shapes only what the model receives. The stored transcript is
    // append-only, so scrolling back or reopening the session keeps everything.
    const compactionThreshold = this.config?.get?.().agent?.compactAfterMessages ?? 80;
    const compaction = compactMessages(this.session.messages, {
      threshold: compactionThreshold,
      keepRecent: 24,
    });
    const contextHistory = compaction.compacted ? compaction.messages : this.session.messages;
    if (compaction.compacted && this.compactionNoticeFor !== this.session.id) {
      this.compactionNoticeFor = this.session.id;
      this.emit({
        type: 'warning',
        message: `Context compacted: ${compaction.removed} older messages are summarized for the model. The transcript and saved session keep every message.`,
      });
    }

    let userStored = null;
    if (!resume) {
      userStored = this.session.appendMessage({
        role: 'user',
        content: displayPrompt,
        meta: pasted.length ? { attachments: pasted.map(attachmentMeta) } : null,
      });
      if (this.session.session?.model !== model) this.session.setModel(model);
    }

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

    // A resumed turn already has its user message in the transcript; sending it
    // again would duplicate the prompt in the model's view.
    const history = resume
      ? contextHistory.map((message) => ({ ...message }))
      : contextHistory
          .filter((message) => message.id !== userStored.id)
          .map((message) => ({ ...message }));
    const requestMessages = resume
      ? [{ role: 'system', content: systemPrompt }, ...historyToApi(history)]
      : [
          { role: 'system', content: systemPrompt },
          ...historyToApi(history),
          { role: 'user', content: modelPrompt },
        ];

    this.emit({ type: 'phase', phase: PHASES.CONNECTING });
    this.emit({ type: 'status', message: `Connecting to ${providerName(providerId)} (${this.modelName(model)})` });
    this.emit({ type: 'start', model, modelName: this.modelName(model) });

    const reasoning = reasoningSettings(this.config?.get?.() ?? {});
    const reasoningParams = this.config?.get?.().providers?.[this.providerId]?.reasoningParams?.[model] ?? null;

    let loop;
    try {
      loop = await runAgentLoop({
        provider,
        model,
        messages: requestMessages,
        tools: registry.definitions(),
        executeTool: (name, input, opts) => registry.execute(name, input, opts),
        maxIterations: this.config?.get?.().agent?.maxIterations ?? 0,
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
        this.credentials.reportFailure(entry.id, error.httpStatus, error.message);
      }
      if (error?.code === ERROR_CODES.INVALID_MODEL) {
        this.models.markUnavailable(model, error.message);
        this.emit({ type: 'warning', message: `Model unavailable for the current ${providerName(providerId)} key: ${this.modelName(model)}` });
      }
      throw error;
    }

    this.credentials.touch(entry.id);
    if (loop.error?.httpStatus) {
      this.credentials.reportFailure(entry.id, loop.error.httpStatus, loop.error.message);
    }
    if (
      loop.error?.code === ERROR_CODES.AUTH ||
      loop.error?.code === ERROR_CODES.FORBIDDEN ||
      loop.error?.code === ERROR_CODES.ACCOUNT
    ) {
      this.credentials.reportFailure(entry.id, loop.error.httpStatus, loop.error.message);
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
