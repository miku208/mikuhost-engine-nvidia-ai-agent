// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import { truncate } from '../util/text.mjs';
import { composePromptWithAttachments } from '../paste/attachments.mjs';

export const COMPACTION_DEFAULTS = Object.freeze({
  threshold: 80,
  keepRecent: 24,
});

/** Convert a stored session message into an OpenAI-compatible message. */
export function toApiMessage(stored) {
  if (!stored) return null;
  if (stored.role === 'assistant') {
    const toolCalls = stored.meta?.toolCalls;
    if (Array.isArray(toolCalls) && toolCalls.length) {
      return {
        role: 'assistant',
        content: stored.content ?? '',
        tool_calls: toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.function?.name ?? call.name, arguments: call.function?.arguments ?? '{}' },
        })),
      };
    }
    return { role: 'assistant', content: stored.content ?? '' };
  }
  if (stored.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: stored.meta?.toolCallId ?? `call_${stored.id ?? 'unknown'}`,
      content: stored.content ?? '',
    };
  }
  if (stored.role === 'system') return { role: 'system', content: stored.content ?? '' };
  // The transcript stores only the prompt + attachment metadata. Re-expand the
  // actual pasted source here so later turns and resumed sessions keep context.
  if (Array.isArray(stored.meta?.attachments) && stored.meta.attachments.length) {
    return {
      role: 'user',
      content: composePromptWithAttachments(stored.content ?? '', stored.meta.attachments),
    };
  }
  return { role: 'user', content: stored.content ?? '' };
}

export function historyToApi(storedMessages = []) {
  const out = [];
  for (const message of storedMessages) {
    const api = toApiMessage(message);
    if (!api) continue;
    // Drop tool messages that would be orphaned (e.g. after a crash mid-turn).
    if (api.role === 'tool') {
      const previous = out[out.length - 1];
      const hasCall = previous?.role === 'assistant' && Array.isArray(previous.tool_calls);
      if (!hasCall) continue;
    }
    out.push(api);
  }
  return out;
}

/**
 * The last user message when it never received a final answer (nothing but
 * tool traffic after it). A turn killed by an SSH drop or a crash leaves
 * exactly this shape: user message stored, no assistant text. Returns null for
 * a complete conversation, so callers can offer to resume instead of guessing.
 */
export function findUnfinishedTurn(storedMessages = []) {
  const list = Array.isArray(storedMessages) ? storedMessages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!message) continue;
    // Notices and compaction markers do not end a turn.
    if (message.role === 'system') continue;
    if (message.role === 'user') return message;
    if (message.role === 'assistant') {
      const hasToolCalls = Array.isArray(message.meta?.toolCalls) && message.meta.toolCalls.length > 0;
      // A partial answer saved by an explicit Ctrl+C counts as an answer: the
      // user stopped it on purpose and should not be nudged to resume.
      if (!hasToolCalls && String(message.content ?? '').trim()) return null;
    }
  }
  return null;
}

/**
 * Deterministic local compaction: no extra model call, no invented content.
 * Keeps the goal, the files that were touched, the last error and recent turns.
 *
 * Returns a VIEW of the conversation for one request — it does not modify the
 * argument. Callers must treat it as context-window shaping only; the session
 * transcript stays append-only so nothing disappears from the chat.
 */
export function compactMessages(storedMessages, { threshold = 80, keepRecent = 24 } = {}) {
  if (!Array.isArray(storedMessages) || storedMessages.length <= threshold) {
    return { messages: storedMessages ?? [], compacted: false, removed: 0 };
  }

  const older = storedMessages.slice(0, storedMessages.length - keepRecent);
  const recent = storedMessages.slice(-keepRecent);

  const userRequests = [];
  const filesTouched = new Set();
  const toolActions = [];
  let lastError = null;
  let lastAssistant = null;

  for (const message of older) {
    if (message.role === 'user') {
      userRequests.push(truncate(message.content.replace(/\s+/g, ' ').trim(), 220));
    } else if (message.role === 'assistant' && message.content) {
      lastAssistant = truncate(message.content.replace(/\s+/g, ' ').trim(), 300);
    } else if (message.role === 'tool') {
      if (message.meta?.path) filesTouched.add(message.meta.path);
      if (message.toolName) toolActions.push(message.toolName);
      if (message.meta?.ok === false && !lastError) {
        lastError = truncate(message.content.split('\n').slice(0, 4).join(' '), 300);
      }
    }
  }

  const lines = ['[Conversation compacted locally — the saved transcript keeps every message; this summary stands in for the older ones]', ''];
  if (userRequests.length) {
    lines.push('User requests so far:');
    for (const request of userRequests.slice(-12)) lines.push(`- ${request}`);
    lines.push('');
  }
  if (filesTouched.size) {
    lines.push(`Files read or changed: ${Array.from(filesTouched).slice(0, 30).join(', ')}`);
    lines.push('');
  }
  if (toolActions.length) {
    const counts = new Map();
    for (const name of toolActions) counts.set(name, (counts.get(name) ?? 0) + 1);
    lines.push(`Tool usage: ${Array.from(counts, ([name, count]) => `${name}×${count}`).join(', ')}`);
    lines.push('');
  }
  if (lastError) lines.push(`Last tool error: ${lastError}`, '');
  if (lastAssistant) lines.push(`Last assistant summary: ${lastAssistant}`, '');
  const removedCount = older.length;

  return {
    messages: [
      ...older.filter((message) => message.role === 'system' && message.meta?.compaction),
      { role: 'system', content: lines.join('\n').trim(), meta: { compaction: true } },
      ...recent,
    ],
    compacted: true,
    removed: removedCount,
    removedFrom: removedCount,
  };
}

const TOOL_GUIDE = `Tool guidance:
- Inspect before you change: list_directory / read_file / search_text are cheap.
- Paths are relative to the focused project directory shown above; absolute paths must stay inside the workspace.
- Prefer edit_file with a unique old_string over rewriting a whole file.
- run_command is for real work (tests, builds, git status). Commands run in the focused project unless you pass cwd. Do not run destructive commands.
- Never invent file contents or command output. If a tool fails, adapt or ask the user.
- .env files, private keys and credentials require explicit user approval. Never ask the user to paste secrets into the chat.`;

export function buildSystemPrompt({
  workspace,
  focusProject = null,
  projects = [],
  model = null,
  modelName = null,
  toolMode = 'native',
  toolNames = [],
  isRootUser = false,
  shellMode = 'ask',
} = {}) {
  const projectList = projects.slice(0, 25).map((project) => `- ${project.relPath} (${project.type})`).join('\n');
  const fallbackProtocol = toolMode === 'fallback';

  const protocol = fallbackProtocol
    ? `This model has no verified native tool-calling support, so use the text tool protocol.
To call a tool, output a block exactly like this and nothing else in that block:
<tool_call>
{"name":"read_file","arguments":{"path":"package.json"}}
</tool_call>
You may emit several <tool_call> blocks. The harness executes them and replies with <tool_result> blocks.
If you do not need a tool, answer normally without any <tool_call> block.`
    : `Use the provided function tools for any filesystem, search or shell work.`;

  return `You are MikuHost Agent, an AI coding agent running in a terminal on the user's machine.

Workspace root: ${workspace}
Focused project: ${focusProject ?? '(workspace root)'}
Active model: ${modelName ?? model ?? 'unknown'}
Shell permission mode: ${shellMode.toUpperCase()}${shellMode === 'auto' ? ' (unattended — commands, file writes and sensitive reads run without approval; do not stop to ask, finish the task)' : ''}${isRootUser ? ' (agent runs as root — commands affect the whole system)' : ''}

Projects discovered in this workspace:
${projectList || '- (none detected yet)'}

${protocol}

Available tools: ${toolNames.join(', ')}

${TOOL_GUIDE}

Operating rules:
- Answer in the user's language (Indonesian or English). Be direct and concise; use short markdown sections and code blocks.
- Explore the actual project before making claims about it. When the user asks about another project, use its path under the workspace; do not require them to change directory.
- After changing files, briefly state what changed and what should be verified.
- Never print API keys, credentials or the contents of secret files.
- If a tool call is denied, stop and ask the user instead of retrying the same action.`;
}

/** Build the full request message list (system prompt + compacted history + new user message). */
export function buildRequestMessages({
  systemPrompt,
  history = [],
  userPrompt = null,
  compaction = COMPACTION_DEFAULTS,
}) {
  const { messages: compacted, compacted: didCompact, removed } = compactMessages(history, {
    threshold: compaction.threshold ?? COMPACTION_DEFAULTS.threshold,
    keepRecent: compaction.keepRecent ?? COMPACTION_DEFAULTS.keepRecent,
  });
  const apiHistory = historyToApi(compacted);
  const messages = [{ role: 'system', content: systemPrompt }, ...apiHistory];
  if (userPrompt !== null) messages.push({ role: 'user', content: userPrompt });
  return { messages, compacted: didCompact, removed };
}
