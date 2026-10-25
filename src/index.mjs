/**
 * Public programmatic surface for MikuHost Agent.
 * The CLI uses the same modules; they are exported so the agent can be
 * embedded in other tools and so tests can exercise them directly.
 */
export { main, packageVersion, USAGE } from './cli/commands.mjs';
export { parseArgs } from './cli/arguments.mjs';
export { runDoctor } from './cli/doctor.mjs';

export { ConfigManager, DEFAULT_CONFIG, DEFAULT_MODEL, DEFAULT_BASE_URL, mergeWithDefaults } from './config/manager.mjs';
export { paths, ensureConfigDir } from './config/paths.mjs';

export { CredentialManager } from './credentials/manager.mjs';
export { loadCredentialStore, saveCredentialStore, validateKeyFormat } from './credentials/storage.mjs';
export { maskKey, redactSecrets } from './util/text.mjs';

export { NvidiaProvider } from './providers/nvidia.mjs';
export { ProviderError, ERROR_CODES, describeProviderError } from './providers/errors.mjs';
export { ModelRegistry, BUILTIN_MODELS, prettifyModelId } from './models/registry.mjs';

export { SessionManager } from './sessions/manager.mjs';
export { openSessionStore, SqliteSessionStore, JsonSessionStore } from './sessions/database.mjs';

export { Workspace, resolveWorkspaceRoot, canonicalize, isPathInside, isRootUser } from './security/workspace.mjs';
export { evaluateShellCommand, analyzeCommand, evaluateFileRead, evaluateFileWrite } from './security/permissions.mjs';
export { classifySensitive, isSensitive } from './security/sensitive-files.mjs';

export { ToolRegistry } from './tools/registry.mjs';
export { validateSchema } from './tools/schema.mjs';

export { AgentRuntime, AgentSetupError } from './core/agent.mjs';
export { runAgentLoop, extractProtocolToolCalls } from './core/agent-loop.mjs';
export { buildSystemPrompt, compactMessages, historyToApi } from './core/context.mjs';
export { createEmitter, EVENTS } from './core/events.mjs';

export { scanProjects, findProject, readPackageSummary } from './projects/scanner.mjs';
