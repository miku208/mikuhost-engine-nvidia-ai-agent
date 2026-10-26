// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import { h } from './h.mjs';
import { theme } from './theme.mjs';
import { useTerminalSize } from './hooks/use-terminal-size.mjs';
import { useSpinner } from './hooks/use-spinner.mjs';
import { createInputTrace } from './input-trace.mjs';
import { InputController } from './input-controller.mjs';
import { buildChatLines, buildHeaderLines } from './text-layout.mjs';
import { applyTextInput, insertPlainText, moveCursorVertical } from './input-edit.mjs';
import {
  COMPOSER_BORDER_ROWS,
  buildComposerLayout,
  attachmentWindow,
  composerTextLines,
  maxAttachmentRows,
} from './composer-layout.mjs';
import { viewportMetrics, anchorOffset, scrollBy as scrollOffsetBy } from './viewport.mjs';
import {
  attachmentsCharacterCount,
  containsSecrets,
  createPasteBatcher,
  createPastedAttachment,
  formatAttachmentCard,
  formatCount,
  pasteSettings,
  previewAttachment,
  sanitizeForDisplay,
  shouldBecomeAttachment,
} from '../paste/attachments.mjs';
import { parseSgrMouse, MOUSE_ENABLE, MOUSE_DISABLE, mouseEnabled } from './mouse.mjs';
import { cycleSelection, escapeAction, lineAtRow, removeAttachmentById } from './selection.mjs';
import { reasoningSettings, REASONING_MODES } from '../reasoning/parser.mjs';
import { HELP_TEXT, parseSlash, suggestCommands, completeCommand } from './slash.mjs';
import { Header } from './components/header.mjs';
import { ActivityEngine, phaseStatusLabel } from './components/activity.mjs';
import { PromptInput } from './components/prompt-input.mjs';
import { StatusBar } from './components/status-bar.mjs';
import { Sidebar, sidebarWidth } from './components/sidebar.mjs';
import { ApprovalDialog } from './components/approval-dialog.mjs';
import { ErrorDialog } from './components/error-dialog.mjs';
import { SessionsPanel } from './panels/sessions.mjs';
import { ModelsPanel } from './panels/models.mjs';
import { KeysPanel } from './panels/keys.mjs';
import { SettingsPanel, SETTINGS_ROW_KEYS } from './panels/settings.mjs';
import { ProjectsPanel } from './panels/projects.mjs';
import { SetupWizard } from './setup-wizard.mjs';
import { CredentialManager } from '../credentials/manager.mjs';
import { normalizeKeyInput } from '../credentials/storage.mjs';
import { SessionManager } from '../sessions/manager.mjs';
import { AgentRuntime } from '../core/agent.mjs';
import { PHASES } from '../core/events.mjs';
import { createProvider, providerName, resolveProviderId } from '../providers/catalog.mjs';
import { compactMessages, findUnfinishedTurn } from '../core/context.mjs';
import { resolveWorkspaceRoot, Workspace, expandHome, isRootUser } from '../security/workspace.mjs';
import { maskKey, titleFromPrompt, truncate } from '../util/text.mjs';

// Ask the terminal to wrap pasted text in ESC[200~ / ESC[201~ markers. Without
// this, a supporting terminal never sends paste boundaries at all.
const BRACKETED_PASTE_ENABLE = '\u001b[?2004h';
const BRACKETED_PASTE_DISABLE = '\u001b[?2004l';

export function createEnvironment({
  config,
  credentials,
  workspace,
  modelId = null,
  restore = false,
  sessionId = null,
}) {
  const session = new SessionManager({ config, workspace: workspace.root });
  let restored = null;
  try {
    if (sessionId) {
      session.cleanupEmptySessions({ keepId: sessionId });
      restored = session.open(sessionId);
    } else if (restore) {
      session.cleanupEmptySessions();
      restored = session.restoreLast();
    } else {
      // Normal startup always starts a new conversation. Old empty sessions
      // from crashed or abandoned runs are removed; non-empty history remains.
      session.cleanupEmptySessions();
    }
  } catch {
    restored = null;
  }
  if (restored) {
    if (session.session.workspace && session.session.workspace !== workspace.root) {
      session.setWorkspace(workspace.root);
    }
    if (modelId) session.setModel(modelId);
    if (session.session.project) {
      try {
        workspace.setFocus(session.session.project);
      } catch {
        workspace.setFocus(null);
      }
    }
  } else {
    session.create({ model: modelId ?? config.get().defaultModel, workspace: workspace.root });
  }
  const runtime = new AgentRuntime({
    config,
    workspace,
    credentials,
    session,
    isRoot: isRootUser(),
  });
  return {
    session,
    runtime,
    workspace,
    history: runtime.history,
    sessionMissing: Boolean(sessionId && !restored),
  };
}

function App({
  config,
  credentials,
  initialEnv,
  needsSetup,
  initialWorkspace,
  initialModel,
  version,
  holder,
  inputController = null,
  inputTrace = null,
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { columns, rows } = useTerminalSize();
  const inputTraceRef = useRef(null);
  if (!inputTraceRef.current) inputTraceRef.current = inputTrace ?? createInputTrace();
  const envRef = useRef(initialEnv);
  const [envVersion, setEnvVersion] = useState(0);
  if (holder) holder.env = envRef.current;

  const [ready, setReady] = useState(!needsSetup);
  const [messages, setMessages] = useState(() => initialEnv.session.messages);
  const [sessions, setSessions] = useState(() => initialEnv.session.list());
  const [projects, setProjects] = useState(() => initialEnv.runtime.projectScan?.projects ?? []);
  const [projectMeta, setProjectMeta] = useState(() => ({
    truncated: initialEnv.runtime.projectScan?.truncated ?? false,
    durationMs: initialEnv.runtime.projectScan?.durationMs ?? 0,
  }));

  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState(() =>
    initialEnv.session.messages.filter((message) => message.role === 'user').map((message) => message.content),
  );
  const [historyIndex, setHistoryIndex] = useState(null);

  const [busy, setBusy] = useState(false);
  const [busySince, setBusySince] = useState(null);
  const [phase, setPhase] = useState(PHASES.IDLE);
  const [draft, setDraft] = useState(null);
  const [activities, setActivities] = useState([]);
  const [notice, setNotice] = useState(() =>
    initialEnv.sessionMissing
      ? { text: 'Requested session was not found. Started a new session.', tone: 'warning' }
      : unfinishedTurnNotice(initialEnv.session.messages),
  );
  const [tokenTotal, setTokenTotal] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [newOutput, setNewOutput] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const attachmentsRef = useRef(attachments);
  // Explicit paste capture (`/paste`): pasted chunks accumulate here until the
  // user presses Enter, so a non-bracketed terminal has a clear block boundary.
  const [pasteCapture, setPasteCapture] = useState(null);
  const pasteModeRef = useRef({ active: false, text: '' });
  // Unknown until the terminal actually sends ESC[200~; enabling the mode in
  // the terminal is not proof that its client emits markers.
  const [pasteMarkers, setPasteMarkers] = useState(() => Boolean(inputController?.bracketedReceived));
  // null = composer has focus; { kind: 'attachment'|'reasoning', id } = a card.
  const [selection, setSelection] = useState(null);
  const [liveReasoning, setLiveReasoning] = useState(null);
  const [expandedReasoningIds, setExpandedReasoningIds] = useState(() => new Set());
  const [reasoningMode, setReasoningMode] = useState(() => reasoningSettings(config.get()).mode);

  const [panel, setPanel] = useState(null);
  const [panelSelection, setPanelSelection] = useState(0);
  const [approval, setApproval] = useState(null);
  const [errorDialog, setErrorDialog] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [keysMessage, setKeysMessage] = useState(null);
  const [modelsMessage, setModelsMessage] = useState(null);
  const [permissionsVersion, setPermissionsVersion] = useState(0);
  const [permissionWarning, setPermissionWarning] = useState(null);
  const [viewFromId, setViewFromId] = useState(null);
  const [mouseOn, setMouseOn] = useState(() => mouseEnabled(config));

  const busyRef = useRef(false);
  const abortRef = useRef(null);
  const approvalResolverRef = useRef(null);
  const streamRef = useRef({ buffer: '', timer: null, typing: true });
  const lastPromptRef = useRef(null);
  const activityIdRef = useRef(0);
  const maxScrollRef = useRef(0);
  const mountedRef = useRef(true);
  const pasteCommitRef = useRef(null);
  const pasteBatchRef = useRef(null);
  if (!pasteBatchRef.current) {
    pasteBatchRef.current = createPasteBatcher({
      delayMs: pasteSettings(config.get()).batchDelayMs,
      commit: (content) => pasteCommitRef.current?.(content, { batched: true }),
    });
  }
  const lastPasteCommitRef = useRef({ id: null, at: 0, batched: false });
  const pasteHandlerRef = useRef(null);
  const pendingSendRef = useRef(null);
  const previousLineCountRef = useRef(0);
  const reasoningStreamRef = useRef({ buffer: '', timer: null, startedAt: 0 });
  // Bracketed paste is published outside this render closure, so the focused
  // prompt is read through a ref instead of a stale state value.
  const promptRef = useRef(null);
  promptRef.current = prompt;

  const addActivity = useCallback((text, meta = {}) => {
    if (!text) return;
    setActivities((previous) => {
      const last = previous[previous.length - 1];
      if (!meta.kind && last && !last.kind && last.text === text) return previous;
      const next = [...previous, { id: (activityIdRef.current += 1), text, ...meta }];
      return next.slice(-12);
    });
  }, []);

  const completeActivity = useCallback((toolName, { ok, durationMs = 0, error = null } = {}) => {
    setActivities((previous) => {
      const offset = [...previous]
        .reverse()
        .findIndex((activity) => activity.kind === 'tool' && activity.toolName === toolName && activity.status === 'running');
      if (offset === -1) return previous;
      const index = previous.length - 1 - offset;
      const next = [...previous];
      next[index] = {
        ...next[index],
        status: ok ? 'ok' : 'fail',
        durationMs,
        text: `${toolName}${next[index].detail ? ` · ${next[index].detail}` : ''}${ok ? '' : ` — ${String(error ?? 'failed').split('\n')[0].slice(0, 70)}`}`,
      };
      return next;
    });
  }, []);

  const flushStream = useCallback(() => {
    const state = streamRef.current;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const chunk = state.buffer;
    state.buffer = '';
    if (!chunk) return;
    setDraft((previous) => ({
      content: `${previous?.content ?? ''}${chunk}`,
      typing: state.typing ?? previous?.typing ?? true,
    }));
  }, []);

  const pushStream = useCallback(
    (text, streaming = true) => {
      const state = streamRef.current;
      state.typing = streaming !== false;
      state.buffer += text;
      if (!state.timer) {
        state.timer = setTimeout(() => {
          streamRef.current.timer = null;
          const chunk = streamRef.current.buffer;
          const typing = streamRef.current.typing;
          streamRef.current.buffer = '';
          if (chunk) setDraft((previous) => ({ content: `${previous?.content ?? ''}${chunk}`, typing }));
        }, 50);
      }
    },
    [],
  );

  // Reasoning is buffered like the answer, so a fast provider cannot trigger a
  // render per token. It is rendered in its own block, never mixed with draft.
  const flushReasoning = useCallback(() => {
    const state = reasoningStreamRef.current;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const chunk = state.buffer;
    state.buffer = '';
    if (!chunk) return;
    setLiveReasoning((previous) => {
      const base = previous ?? { text: '', active: true, ms: 0, expanded: true };
      return { ...base, text: `${base.text ?? ''}${chunk}`, active: true };
    });
  }, []);

  const pushReasoningChunk = useCallback(
    (text) => {
      if (typeof text !== 'string' || !text) return;
      const state = reasoningStreamRef.current;
      state.buffer += text;
      if (!state.timer) {
        state.timer = setTimeout(() => {
          state.timer = null;
          flushReasoning();
        }, 50);
      }
    },
    [flushReasoning],
  );

  const startReasoning = useCallback(() => {
    const settings = reasoningSettings(config.get());
    reasoningStreamRef.current.startedAt = Date.now();
    setLiveReasoning((previous) => ({
      text: previous?.text ?? '',
      active: true,
      ms: previous?.ms ?? 0,
      expanded: previous?.expanded ?? true,
      // A new segment after a completed one starts its own live timer.
      startedAt: previous?.active ? previous.startedAt ?? Date.now() : Date.now(),
      showElapsedTime: settings.showElapsedTime,
    }));
  }, [config]);

  const completeReasoning = useCallback(
    (durationMs = null) => {
      const settings = reasoningSettings(config.get());
      const measured = Number.isFinite(durationMs)
        ? Math.max(0, Number(durationMs))
        : Math.max(0, Date.now() - (reasoningStreamRef.current.startedAt || Date.now()));
      setLiveReasoning((previous) => {
        if (!previous) return previous;
        const expanded = settings.mode === 'on' ? true : !settings.autoCollapseAfterComplete;
        return {
          ...previous,
          active: false,
          ms: (previous.ms ?? 0) + measured,
          expanded: previous.expanded === false ? false : expanded,
          showElapsedTime: settings.showElapsedTime,
        };
      });
      reasoningStreamRef.current.startedAt = 0;
    },
    [config],
  );

  const settleReasoning = useCallback(() => {
    flushReasoning();
    setLiveReasoning((previous) => {
      if (!previous || !previous.active) return previous;
      const measured = Math.max(0, Date.now() - (reasoningStreamRef.current.startedAt || Date.now()));
      const settings = reasoningSettings(config.get());
      return {
        ...previous,
        active: false,
        ms: (previous.ms ?? 0) + measured,
        expanded: settings.mode === 'on' || !settings.autoCollapseAfterComplete,
      };
    });
    reasoningStreamRef.current.startedAt = 0;
  }, [config, flushReasoning]);

  const handleRuntimeEvent = useCallback(
    (event) => {
      switch (event.type) {
        case 'phase':
          setPhase(event.phase);
          break;
        case 'status':
          addActivity(event.message);
          break;
        case 'warning':
          addActivity(event.message);
          break;
        case 'reasoning:start':
          if (reasoningSettings(config.get()).mode === 'off') break;
          startReasoning();
          break;
        case 'reasoning:chunk':
          if (reasoningSettings(config.get()).mode === 'off') break;
          pushReasoningChunk(event.text);
          break;
        case 'reasoning:complete':
          flushReasoning();
          completeReasoning(event.durationMs);
          break;
        case 'text':
          // Streaming is real: this event only fires for chunks the provider
          // actually sent. Never replay a final answer character by character.
          pushStream(event.text, event.streaming !== false);
          break;
        case 'tool-start': {
          const detail =
            event.input?.path ?? event.input?.command ?? event.input?.pattern ?? event.input?.query ?? null;
          const detailText = detail ? String(detail).slice(0, 70) : null;
          addActivity(`${event.toolName}${detailText ? ` · ${detailText}` : ''}`, {
            kind: 'tool',
            status: 'running',
            toolName: event.toolName,
            detail: detailText,
          });
          break;
        }
        case 'tool-end':
          completeActivity(event.toolName, {
            ok: event.ok,
            durationMs: event.durationMs,
            error: event.error,
          });
          break;
        case 'tool-approval':
          setPhase(PHASES.WAITING_APPROVAL);
          break;
        case 'usage':
          setTokenTotal(event.total?.totalTokens ?? 0);
          break;
        case 'error':
          setPhase(PHASES.ERROR);
          flushStream();
          settleReasoning();
          setErrorDialog({ error: event.error, canRetry: Boolean(lastPromptRef.current), canChangeKey: true });
          break;
        case 'start':
          setActivities([]);
          setSelection(null);
          setExpandedReasoningIds(new Set());
          reasoningStreamRef.current = { buffer: '', timer: null, startedAt: 0 };
          setLiveReasoning(null);
          setPhase(PHASES.CONNECTING);
          break;
        case 'done':
          flushStream();
          flushReasoning();
          setPhase(event.aborted ? PHASES.CANCELLED : event.error ? PHASES.ERROR : PHASES.COMPLETED);
          break;
        default:
          break;
      }
    },
    [
      addActivity,
      completeActivity,
      pushStream,
      flushStream,
      startReasoning,
      pushReasoningChunk,
      flushReasoning,
      completeReasoning,
      settleReasoning,
    ],
  );

  useEffect(() => {
    envRef.current.runtime.setEventHandler(handleRuntimeEvent);
    envRef.current.runtime.setApprovalHandler(
      (request) =>
        new Promise((resolve) => {
          approvalResolverRef.current = resolve;
          setApproval(request);
        }),
    );
  }, [handleRuntimeEvent, envVersion]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // Bracketed paste is published by the input controller, never by Ink: the
  // paste payload never enters the composer stream.
  useEffect(() => {
    if (!inputController?.onPaste) return undefined;
    return inputController.onPaste((content) => pasteHandlerRef.current?.(content));
  }, [inputController]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      approvalResolverRef.current?.(false);
      pasteBatchRef.current?.reset();
      try {
        envRef.current.session.close();
      } catch {
        /* ignore */
      }
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      const scan = envRef.current.runtime.scanProjects();
      setProjects(scan.projects);
      setProjectMeta({ truncated: scan.truncated, durationMs: scan.durationMs });
    } catch {
      /* scanning is best-effort */
    }
  }, [ready, envVersion]);

  useEffect(() => {
    if (!stdout?.isTTY) return undefined;
    try {
      stdout.write(BRACKETED_PASTE_ENABLE);
    } catch {
      /* terminal does not support it; /paste remains available */
    }
    return () => {
      try {
        stdout.write(BRACKETED_PASTE_DISABLE);
      } catch {
        /* ignore */
      }
    };
  }, [stdout]);

  useEffect(() => {
    if (!stdout?.isTTY) return undefined;
    if (!mouseOn) {
      try {
        stdout.write(MOUSE_DISABLE);
      } catch {
        /* ignore */
      }
      return undefined;
    }
    try {
      stdout.write(MOUSE_ENABLE);
    } catch {
      /* ignore */
    }
    return () => {
      try {
        stdout.write(MOUSE_DISABLE);
      } catch {
        /* ignore */
      }
    };
  }, [mouseOn, stdout]);

  const { frame, elapsedMs } = useSpinner(busy, busySince);

  useEffect(() => {
    if (ready) return;
    setReady(credentials.size > 0);
  }, [ready, config, credentials]);

  // ---- session / workspace actions -------------------------------------------

  /** One-line heads-up when a saved conversation stops after a user message. */
  function unfinishedTurnNotice(messages) {
    const pending = findUnfinishedTurn(messages);
    if (!pending) return null;
    const preview = truncate(String(pending.content ?? '').replace(/\s+/g, ' ').trim(), 60);
    return {
      text: `The last turn did not finish${preview ? ` after "${preview}"` : ''}. Run /continue to resume it, or send a new message.`,
      tone: 'warning',
    };
  }

  function syncFromSession({ keepScroll = false } = {}) {
    const current = envRef.current;
    setMessages([...current.session.messages]);
    setSessions(current.session.list());
    if (!keepScroll) setScrollOffset(0);
  }

  function resetComposerCards() {
    setSelection(null);
    setLiveReasoning(null);
    setExpandedReasoningIds(new Set());
    reasoningStreamRef.current = { buffer: '', timer: null, startedAt: 0 };
    pasteBatchRef.current?.reset();
    lastPasteCommitRef.current = { id: null, at: 0, batched: false };
    pasteModeRef.current = { active: false, text: '' };
    setPasteCapture(null);
  }

  function newSession() {
    if (busyRef.current) {
      setNotice({ text: 'Cancel the running turn first (Ctrl+C).', tone: 'warning' });
      return;
    }
    const current = envRef.current;
    // Do not leave an unused row in the session history.
    current.session.discardIfEmpty();
    current.session.create({
      model: current.runtime.activeModel,
      workspace: current.workspace.root,
      project: current.session.session?.project ?? null,
    });
    setMessages([]);
    setSessions(current.session.list());
    setScrollOffset(0);
    setNewOutput(false);
    setViewFromId(null);
    setInput('');
    setCursor(0);
    setAttachments([]);
    resetComposerCards();
    setNotice({ text: 'New session started.', tone: 'info' });
  }

  function openSession(id) {
    if (busyRef.current) {
      setNotice({ text: 'Cancel the running turn before opening another session.', tone: 'warning' });
      setPanel(null);
      return;
    }
    const current = envRef.current;
    current.session.discardIfEmpty();
    const opened = current.session.open(id);
    if (!opened) {
      setPanel(null);
      setNotice({ text: 'Session not found.', tone: 'error' });
      return;
    }
    if (opened.project) {
      try {
        current.workspace.setFocus(opened.project);
      } catch {
        current.workspace.setFocus(null);
      }
    }
    setMessages([...current.session.messages]);
    setPanel(null);
    setScrollOffset(0);
    setViewFromId(null);
    setHistory(current.session.messages.filter((m) => m.role === 'user').map((m) => m.content));
    setHistoryIndex(null);
    setInput('');
    setCursor(0);
    setAttachments([]);
    resetComposerCards();
    setNewOutput(false);
    setNotice(unfinishedTurnNotice(current.session.messages));
    addActivity(`Opened session "${opened.title}"`);
  }

  function switchWorkspace(target) {
    try {
      let nextWorkspace;
      if (!target || target === 'reset') {
        config.setValue('workspace', null);
        const resolved = resolveWorkspaceRoot({ saved: null, explicit: null });
        nextWorkspace = new Workspace(resolved.root);
        config.setValue('workspace', nextWorkspace.root);
      } else {
        nextWorkspace = new Workspace(expandHome(target));
        config.setValue('workspace', nextWorkspace.root);
      }
      const previous = envRef.current;
      const next = createEnvironment({
        config,
        credentials,
        workspace: nextWorkspace,
        modelId: previous.runtime.activeModel,
        restore: false,
      });
      envRef.current = next;
      holder && (holder.env = next);
      setEnvVersion((value) => value + 1);
      setMessages([...next.session.messages]);
      setSessions(next.session.list());
      setProjects([]);
      setProjectMeta({ truncated: false, durationMs: 0 });
      setScrollOffset(0);
      setViewFromId(null);
      setPanel(null);
      setInput('');
      setCursor(0);
      setAttachments([]);
      resetComposerCards();
      setNewOutput(false);
      try {
        previous.session.discardIfEmpty();
        previous.session.close();
      } catch {
        /* ignore */
      }
      setNotice({ text: `Workspace: ${nextWorkspace.root}`, tone: 'info' });
    } catch (error) {
      setNotice({ text: `Workspace error: ${error.message}`, tone: 'error' });
    }
  }

  // ---- sending --------------------------------------------------------------

  async function sendPrompt(raw, options = {}) {
    const text = String(raw ?? '').trim();
    // Use the ref: a bracketed paste and Enter can arrive in the same terminal
    // read, before React commits the attachment state to the next render.
    const outgoing = Array.isArray(options.attachments) ? options.attachments : attachmentsRef.current;
    const pastedAttachments = outgoing.filter((attachment) => attachment?.content);
    if (!text && !pastedAttachments.length) return;
    if (text.startsWith('/') && !pastedAttachments.length) {
      setInput('');
      setCursor(0);
      handleSlash(text);
      return;
    }
    if (busyRef.current) {
      setNotice({ text: 'A turn is already running. Press Ctrl+C to cancel it.', tone: 'warning' });
      return;
    }

    const pasteConfig = pasteSettings(config.get());
    const totalAttachmentChars = attachmentsCharacterCount(pastedAttachments);
    if (totalAttachmentChars > pasteConfig.maxContextCharacters) {
      setNotice({
        text: `Attachments are ${formatCount(totalAttachmentChars)} characters, above the ${formatCount(pasteConfig.maxContextCharacters)} character context limit. Split the code or save it as a file in the workspace and reference the path.`,
        tone: 'error',
      });
      return;
    }
    if (
      pastedAttachments.length &&
      !options.confirmedSecrets &&
      pastedAttachments.some((attachment) => containsSecrets(attachment.content))
    ) {
      pendingSendRef.current = { text, attachments: pastedAttachments };
      setNotice({
        text: 'Warning: the pasted attachment looks like it contains a credential (API key, token or private key). Press Enter again to send it to NVIDIA, or Esc to cancel.',
        tone: 'warning',
      });
      return;
    }
    pendingSendRef.current = null;

    setInput('');
    setCursor(0);
    if (text) {
      setHistory((previous) => (previous[previous.length - 1] === text ? previous : [...previous, text]).slice(-100));
    }
    setHistoryIndex(null);
    return runTurn({ current: envRef.current, text, pastedAttachments });
  }

  /** Re-run a turn that stopped before any answer (SSH drop, crash, restart). */
  function continueTurn() {
    if (busyRef.current) {
      setNotice({ text: 'A turn is already running. Press Ctrl+C to cancel it.', tone: 'warning' });
      return;
    }
    const current = envRef.current;
    if (!findUnfinishedTurn(current.session.messages)) {
      setNotice({ text: 'No unfinished turn to continue.', tone: 'info' });
      return;
    }
    return runTurn({ current, text: '', pastedAttachments: [], resume: true });
  }

  async function runTurn({ current, text, pastedAttachments, resume = false }) {
    setNotice(null);
    setActivities([]);
    setDraft({ content: '', typing: true });
    streamRef.current.typing = true;
    setScrollOffset(0);
    setNewOutput(false);
    setViewFromId(null);
    streamRef.current.buffer = '';
    if (!resume) lastPromptRef.current = { text, attachments: pastedAttachments };
    // The request owns the content from here on; clearing the composer keeps it
    // responsive for new typing while the agent works.
    setAttachments([]);
    setSelection(null);
    busyRef.current = true;
    setBusy(true);
    setBusySince(Date.now());
    setPhase(PHASES.CONNECTING);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = resume
        ? await current.runtime.continueTurn({ signal: controller.signal })
        : await current.runtime.send(text, {
            signal: controller.signal,
            attachments: pastedAttachments,
          });
      flushStream();
      syncFromSession();
      if (result.aborted) {
        setPhase(PHASES.CANCELLED);
        setNotice({ text: 'Turn cancelled. Partial output was saved.', tone: 'warning' });
      } else if (result.error) {
        setPhase(PHASES.ERROR);
      } else {
        setPhase(PHASES.COMPLETED);
      }
    } catch (error) {
      flushStream();
      if (error.code === 'NO_CREDENTIALS') {
        setNotice({ text: error.message, tone: 'error' });
        openPanel('keys');
      } else if (error.code === 'ABORTED') {
        setPhase(PHASES.CANCELLED);
        setNotice({ text: 'Cancelled.', tone: 'warning' });
      } else if (error.code === 'NOTHING_TO_CONTINUE') {
        setPhase(PHASES.IDLE);
        setNotice({ text: error.message, tone: 'info' });
      } else {
        setPhase(PHASES.ERROR);
        setErrorDialog({ error, canRetry: true, canChangeKey: true });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      setBusySince(null);
      setDraft(null);
      abortRef.current = null;
      syncFromSession({ keepScroll: false });
      // Hand the live panel over to the persisted, collapsible one so reopening
      // the session keeps the same reasoning available.
      const latestReasoned = [...current.session.messages]
        .reverse()
        .find((message) => message.role === 'assistant' && typeof message.meta?.reasoning === 'string' && message.meta.reasoning.trim());
      const reasoningPrefs = reasoningSettings(config.get());
      if (latestReasoned && (reasoningPrefs.mode === 'on' || !reasoningPrefs.autoCollapseAfterComplete)) {
        setExpandedReasoningIds((previous) => new Set(previous).add(latestReasoned.id));
      }
      flushReasoning();
      setLiveReasoning(null);
      reasoningStreamRef.current = { buffer: '', timer: null, startedAt: 0 };
      // The completed/typing timer lives in the message metadata now; the live
      // activity header returns to idle once the turn is over.
      setPhase(PHASES.IDLE);
    }
  }

  function retryLastPrompt() {
    const previous = lastPromptRef.current;
    setErrorDialog(null);
    if (!previous) return;
    if (typeof previous === 'string') {
      sendPrompt(previous);
      return;
    }
    sendPrompt(previous.text, { attachments: previous.attachments, confirmedSecrets: true });
  }

  function answerApproval(allow) {
    const resolve = approvalResolverRef.current;
    approvalResolverRef.current = null;
    setApproval(null);
    resolve?.(allow);
  }

  // ---- panels ---------------------------------------------------------------

  function openPanel(name) {
    setPanel(name);
    setPanelSelection(0);
    setConfirming(null);
    setPrompt(null);
    setKeysMessage(null);
    setModelsMessage(null);
    if (name === 'sessions') setSessions(envRef.current.session.list());
    if (name === 'projects') {
      const scan = envRef.current.runtime.scanProjects();
      setProjects(scan.projects);
      setProjectMeta({ truncated: scan.truncated, durationMs: scan.durationMs });
    }
  }

  function closePanel() {
    setPanel(null);
    setConfirming(null);
    setPrompt(null);
    setKeysMessage(null);
    setModelsMessage(null);
  }

  // ---- slash commands -------------------------------------------------------

  function applyPermission(key, value) {
    if (key === 'all') {
      for (const field of ['shell', 'fileWrite', 'sensitiveRead']) {
        config.setValue(`permissions.${field}`, value);
      }
      setPermissionsVersion((versionNumber) => versionNumber + 1);
      setNotice({
        text:
          value === 'auto'
            ? 'Unattended mode on — every tool call runs without asking. Commands execute with your OS user privileges; there is still no sandbox.'
            : 'Unattended mode off — shell, file writes and sensitive reads ask again.',
        tone: value === 'auto' ? 'warning' : 'info',
      });
      return;
    }
    const path = key === 'shell' ? 'permissions.shell' : key === 'file' ? 'permissions.fileWrite' : 'permissions.sensitiveRead';
    config.setValue(path, value);
    setPermissionsVersion((versionNumber) => versionNumber + 1);
    setNotice({
      text:
        value === 'auto'
          ? `${path} = auto — this policy no longer asks for approval.`
          : `${path} = ${value}${key === 'shell' && value === 'allow' ? ' — guarded and destructive commands still require approval.' : ''}`,
      tone: value === 'auto' ? 'warning' : 'info',
    });
  }

  function requestPermission(key, value) {
    // Anything that stops approval prompts entirely has to be confirmed first.
    if (value === 'auto') {
      setPermissionWarning({ key, value });
      return;
    }
    if (key === 'shell' && value === 'allow' && config.get().permissions.shell !== 'allow') {
      setPermissionWarning({ key, value });
      return;
    }
    applyPermission(key, value);
  }

  /**
   * Every model whose provider has a key. Selecting one switches the active
   * credential to that provider (DeepSeek → TokenHarbor key, NVIDIA models →
   * NVIDIA key), so the panel stays the single place to pick a model.
   */
  function modelsForPanel() {
    const runtime = envRef.current.runtime;
    const providers = new Set(credentials.providers());
    return runtime.models.list().filter((model) => providers.has(resolveProviderId(model.provider)));
  }

  function statusText() {
    const current = envRef.current;
    const permissions = config.get().permissions;
    const activeKey = credentials.activeEntry();
    const focus = current.workspace.focusedPath;
    return [
      `Model       ${current.runtime.modelName()}`,
      `Workspace   ${current.workspace.root}${focus ? `  (focus: ${focus})` : ''}`,
      `Session     ${current.session.title}  ·  ${current.session.messages.length} messages`,
      `Provider    ${providerName(current.runtime.providerId)} (${current.runtime.providerId}) · ${config.baseUrlFor(current.runtime.providerId) || 'no base URL'}`,
      `Key         ${activeKey ? `${activeKey.name} ${maskKey(activeKey.key)}${activeKey.source === 'env' ? ' (env)' : ''}` : 'none'}`,
      `Permissions shell=${permissions.shell} fileWrite=${permissions.fileWrite} sensitiveRead=${permissions.sensitiveRead}`,
      `Reasoning   ${reasoningSettings(config.get()).mode}`,
      `Paste       bracketed markers ${inputController?.bracketedReceived ? 'received' : 'not received (fallback batching, /paste for a hard boundary)'}`,
      `Database    ${current.session.kind}`,
      `Tokens      ${tokenTotal} (this process)`,
      `Root        ${isRootUser() ? 'yes — commands inherit system privileges' : 'no'}`,
    ].join('\n');
  }

  function handleSlash(raw) {
    const parsed = parseSlash(raw);
    if (!parsed) return;
    const { name, args, argv } = parsed;
    switch (name) {
      case 'help':
        setNotice({ text: HELP_TEXT, tone: 'info' });
        break;
      case 'new':
        if (busyRef.current) setNotice({ text: 'Cancel the running turn first (Ctrl+C).', tone: 'warning' });
        else newSession();
        break;
      case 'sessions':
        openPanel('sessions');
        break;
      case 'models':
        openPanel('models');
        break;
      case 'model': {
        if (!argv.length) {
          openPanel('models');
          break;
        }
        try {
          const entry = envRef.current.runtime.models.resolve(args);
          envRef.current.runtime.setModel(entry.id);
          setNotice({
            text: `Model: ${entry.name} (${entry.id}) · ${providerName(entry.provider)} key ${credentials.activeEntry()?.name ?? 'none'}`,
            tone: 'info',
          });
        } catch (error) {
          setNotice({ text: error.message, tone: 'error' });
        }
        break;
      }
      case 'keys':
        openPanel('keys');
        break;
      case 'paste':
        beginPasteCapture();
        break;
      case 'attachments': {
        if (!attachments.length) {
          setNotice({ text: 'No pasted attachments in the composer. Paste a long block to create one.', tone: 'info' });
          break;
        }
        const maxPreview = pasteSettings(config.get()).maxPreviewLines;
        const text = attachments
          .map(
            (attachment, index) =>
              `${index + 1}. ${formatAttachmentCard(attachment)} · ${formatCount(attachment.lines)} lines${attachment.language ? ` · ${attachment.language}` : ''}\n${previewAttachment(attachment, maxPreview)}`,
          )
          .join('\n\n');
        setNotice({ text: `${text}\n\nTab selects a card · Esc removes the selected card`, tone: 'info' });
        break;
      }
      case 'projects':
        openPanel('projects');
        break;
      case 'project': {
        if (!argv.length) {
          openPanel('projects');
          break;
        }
        try {
          const project = envRef.current.runtime.focusProject(args);
          setProjects(envRef.current.runtime.scanProjects().projects);
          setNotice(
            project
              ? { text: `Focused ${project.relPath} (${project.type})`, tone: 'info' }
              : { text: 'Project focus cleared.', tone: 'info' },
          );
        } catch (error) {
          setNotice({ text: error.message, tone: 'error' });
        }
        break;
      }
      case 'workspace':
        if (busyRef.current) {
          setNotice({ text: 'Cancel the running turn before changing workspace.', tone: 'warning' });
          break;
        }
        switchWorkspace(args || null);
        break;
      case 'settings':
        openPanel('settings');
        break;
      case 'permissions': {
        const key = String(argv[0] ?? '').toLowerCase();
        const value = String(argv[1] ?? '').toLowerCase();
        if (!['shell', 'file', 'sensitive'].includes(key) || !['ask', 'allow', 'auto'].includes(value)) {
          setNotice({ text: 'Usage: /permissions <shell|file|sensitive> <ask|allow|auto>  (auto = unattended, nothing is asked)', tone: 'error' });
          break;
        }
        requestPermission(key, value);
        break;
      }
      case 'status':
        setNotice({ text: statusText(), tone: 'info' });
        break;
      case 'clear': {
        if (busyRef.current) {
          setNotice({ text: 'Cancel the running turn first (Ctrl+C).', tone: 'warning' });
          break;
        }
        envRef.current.session.clearMessages();
        setMessages([]);
        setViewFromId(null);
        setNotice({ text: 'Session conversation cleared.', tone: 'info' });
        break;
      }
      case 'compact': {
        const current = envRef.current;
        const transcript = current.session.messages;
        if (!transcript.length) {
          setNotice({ text: 'Nothing to compact yet.', tone: 'info' });
          break;
        }
        // Compaction is a view of the conversation built for each request; it
        // never deletes transcript messages, so this reports instead of pruning.
        const threshold = config.get().agent?.compactAfterMessages ?? 80;
        const result = compactMessages(transcript, { threshold, keepRecent: 24 });
        if (!result.compacted) {
          setNotice({
            text: `Context fits the window: ${transcript.length}/${threshold} messages are sent to the model in full.`,
            tone: 'info',
          });
          break;
        }
        setNotice({
          text: `Next request sends a local summary plus the last 24 messages (${result.removed} older messages summarized). All ${transcript.length} messages stay in the transcript and in the saved session.`,
          tone: 'info',
        });
        break;
      }
      case 'continue':
        continueTurn();
        break;
      case 'undo': {
        if (busyRef.current) {
          setNotice({ text: 'Cancel the running turn before undoing a file change.', tone: 'warning' });
          break;
        }
        const current = envRef.current;
        const mode = String(args).trim().toLowerCase();
        if (mode === 'list') {
          const entries = current.runtime.history.list({ sessionId: current.session.id, limit: 10 });
          if (!entries.length) {
            setNotice({ text: 'Nothing to undo in this session.', tone: 'info' });
            break;
          }
          setNotice({
            text: [
              'Undo stack (newest first):',
              ...entries.map((entry, index) => {
                const time = new Date(entry.createdAt).toTimeString().slice(0, 8);
                return `  ${index + 1}. ${entry.existed ? 'restore' : 'remove '} ${entry.relPath ?? entry.absolute}  · ${entry.tool} · ${time}`;
              }),
              '',
              '/undo restores the newest one · /undo force ignores later manual changes',
            ].join('\n'),
            tone: 'info',
          });
          break;
        }
        const result = current.runtime.history.undo({
          sessionId: current.session.id,
          force: mode === 'force',
        });
        if (!result.ok) {
          const entry = result.entry;
          setNotice({
            text:
              result.reason === 'empty'
                ? 'Nothing to undo in this session. Only files the agent changed here are tracked.'
                : result.reason === 'changed'
                  ? `${entry.relPath ?? entry.absolute} changed after the agent's edit — undo would overwrite your own changes. Run /undo force to restore the previous version anyway.`
                  : result.reason === 'outside-workspace'
                    ? 'Refused: the recorded path is outside the workspace.'
                    : result.reason === 'missing-snapshot'
                      ? `The saved copy of ${entry.relPath ?? entry.absolute} is missing, so it cannot be restored.`
                      : `Could not undo ${entry?.relPath ?? 'that edit'} (${result.reason}).`,
            tone: 'error',
          });
          break;
        }
        const entry = result.entry;
        const rel = entry.relPath ?? entry.absolute;
        // Keep the transcript honest: the undo belongs in the conversation the
        // model sees next, not only in a transient notice.
        current.session.appendMessage({
          role: 'system',
          content: result.removed
            ? `Undo: removed ${rel} (it had been created by ${entry.tool}).`
            : `Undo: restored ${rel} to the version from before ${entry.tool}.`,
          meta: { undo: true },
        });
        syncFromSession();
        setNotice({
          text: result.removed
            ? `Removed ${rel} — it was created by ${entry.tool} in this session.`
            : `Restored ${rel} to the version before ${entry.tool}.`,
          tone: 'info',
        });
        break;
      }
      case 'rename':
        if (!args) {
          setNotice({ text: 'Usage: /rename <title>', tone: 'error' });
          break;
        }
        envRef.current.session.rename(args);
        setSessions(envRef.current.session.list());
        setNotice({ text: `Session renamed to "${titleFromPrompt(args)}"`, tone: 'info' });
        break;
      case 'reasoning': {
        const value = String(args).toLowerCase();
        if (!value) {
          const settings = reasoningSettings(config.get());
          setNotice({
            text: `Reasoning: ${settings.mode} · auto-collapse ${settings.autoCollapseAfterComplete ? 'on' : 'off'} · elapsed ${settings.showElapsedTime ? 'on' : 'off'}.\nUsage: /reasoning <on|off|auto>. Only reasoning actually sent by the provider is shown.`,
            tone: 'info',
          });
          break;
        }
        if (!REASONING_MODES.includes(value)) {
          setNotice({ text: 'Usage: /reasoning <on|off|auto>', tone: 'error' });
          break;
        }
        config.setValue('ui.reasoning.mode', value);
        setReasoningMode(value);
        if (value === 'off') setLiveReasoning(null);
        setNotice({
          text:
            value === 'off'
              ? 'Reasoning output hidden. Provider reasoning will not be captured or saved.'
              : value === 'on'
                ? 'Reasoning shown and kept expanded after it completes.'
                : 'Reasoning shown live when the provider sends it, then collapsed.',
          tone: 'info',
        });
        break;
      }
      case 'mouse': {
        const value = String(args).toLowerCase();
        if (!['on', 'off'].includes(value)) {
          setNotice({ text: 'Usage: /mouse <on|off>', tone: 'error' });
          break;
        }
        const enabled = value === 'on';
        config.setValue('ui.mouse', enabled);
        setMouseOn(enabled);
        setNotice({ text: `Mouse support ${enabled ? 'enabled' : 'disabled'}.`, tone: 'info' });
        break;
      }
      case 'exit':
        exit();
        break;
      default:
        setNotice({ text: `Unknown command: /${name}. Try /help.`, tone: 'error' });
        break;
    }
  }

  // ---- key handling ---------------------------------------------------------

  const suggestions = useMemo(() => suggestCommands(input), [input]);
  const tiny = rows < 16;
  const compact = rows < 22 || columns < 60;
  const suggestionsHeight = suggestions.length && !panel && !tiny ? 1 : 0;
  const dialogActive = Boolean(approval || errorDialog || permissionWarning);
  // While real chunks are arriving, the answer itself is the activity: show
  // "MikuHost · Typing..." instead of stealing rows from the transcript.
  const streamingNow = busy && phase === PHASES.STREAMING && Boolean(draft?.content);
  const hasLiveReasoning = Boolean(liveReasoning && (liveReasoning.active || String(liveReasoning.text ?? '').trim()));
  const showActivity = busy && !dialogActive && !streamingNow && !hasLiveReasoning;
  const activityLimit = tiny ? 1 : rows < 24 ? 2 : 3;
  const activityHeight = showActivity ? 1 + Math.min(activityLimit, activities.length) : 0;
  const selectedAttachmentId = selection?.kind === 'attachment' ? selection.id : null;
  const reasoningSelected = selection?.kind === 'reasoning';
  const attachmentRowsPreview = attachmentWindow(attachments, maxAttachmentRows(rows), selectedAttachmentId);
  const attachmentRows = attachmentRowsPreview.items.length + (attachmentRowsPreview.hidden ? 1 : 0);
  // The rail is permanent furniture: it is never toggled by a key, only hidden
  // when the terminal simply has no room for it.
  const railWidth = sidebarWidth(columns);
  const mainWidth = columns - railWidth;
  const composerTextRows = composerTextLines(rows, attachmentRows);
  const composerLayout = useMemo(
    () =>
      buildComposerLayout({
        value: input,
        cursor,
        width: Math.max(12, mainWidth - 4),
        maxLines: composerTextRows,
      }),
    [input, cursor, mainWidth, composerTextRows],
  );
  // The border belongs to the composer, so it counts towards the fixed height.
  const composerHeight = composerLayout.lines.length + attachmentRows + COMPOSER_BORDER_ROWS;
  // The composer owns its border, so the status bar no longer draws a divider.
  const statusHeight = tiny ? 1 : 2;
  const chatWidth = Math.max(20, columns - (railWidth ? railWidth + 2 : 2));
  const sessionTitle = envRef.current.session.title;
  const headerLines = useMemo(
    () =>
      buildHeaderLines({
        model: envRef.current.runtime.modelName(),
        workspace: envRef.current.workspace.root,
        session: sessionTitle,
        version,
        width: chatWidth,
      }),
    [chatWidth, sessionTitle, version],
  );
  const expandedReasoningList = useMemo(() => Array.from(expandedReasoningIds), [expandedReasoningIds]);
  const reasoningDisplay = useMemo(
    () => ({
      ...(liveReasoning ?? {}),
      showElapsedTime: reasoningSettings(config.get()).showElapsedTime,
    }),
    // reasoningMode re-reads the saved preference after /reasoning changes it.
    [liveReasoning, config, reasoningMode],
  );
  // The rail mirrors the session itself: completed tool calls come from the
  // saved transcript (so reopening a session shows the same history), and the
  // ones still running are layered on top from the activity list.
  const railTools = useMemo(() => {
    const done = messages
      .filter((message) => message.role === 'tool')
      .map((message) => ({
        id: message.id,
        name: message.toolName ?? 'tool',
        ok: message.meta?.ok !== false,
        durationMs: Number(message.meta?.durationMs) || 0,
      }));
    const running = activities
      .filter((activity) => activity.kind === 'tool' && activity.status === 'running')
      .map((activity) => ({ id: `live-${activity.id}`, name: activity.toolName ?? 'tool', ok: null, running: true }));
    return [...done, ...running];
  }, [messages, activities]);
  const chatLines = useMemo(() => {
    const visibleMessages = viewFromId
      ? messages.slice(Math.max(0, messages.findIndex((message) => message.id === viewFromId) + 1))
      : messages;
    return [
      ...headerLines,
      ...buildChatLines({
        messages: visibleMessages,
        draft,
        notice,
        width: chatWidth,
        reasoning: reasoningDisplay,
        expandedReasoning: expandedReasoningList,
        elapsedMs: liveReasoning?.active
          ? Math.max(0, Date.now() - (liveReasoning.startedAt ?? Date.now()))
          : 0,
      }),
    ];
  }, [
    headerLines,
    messages,
    draft,
    notice,
    chatWidth,
    viewFromId,
    reasoningDisplay,
    expandedReasoningList,
    liveReasoning?.active,
    elapsedMs,
  ]);

  // The header is part of the transcript, so it scrolls away instead of taking
  // permanent vertical space. The composer/status bar are the fixed furniture.
  const chatHeight = Math.max(1, rows - composerHeight - statusHeight - activityHeight - suggestionsHeight);
  const viewport = viewportMetrics({ lineCount: chatLines.length, height: chatHeight, offset: scrollOffset });
  maxScrollRef.current = viewport.maxScroll;
  const startLine = viewport.start;
  const visibleLines = chatLines.slice(viewport.start, viewport.end);
  // Pin a short conversation to the bottom, just above the composer. Without
  // this, the welcome header floats at the top of a large empty region.
  const topPadding = viewport.offset === 0 ? Math.max(0, chatHeight - visibleLines.length) : 0;

  // Notices such as /help and /status start at their first line rather than
  // scrolled to the bottom, but stay scrollable with PgUp/PgDn.
  useEffect(() => {
    if (!notice) return;
    const noticeStart = chatLines.findIndex((line) => line.notice);
    if (noticeStart === -1) return;
    const desired = Math.max(0, Math.min(viewport.maxScroll, chatLines.length - chatHeight - noticeStart));
    setScrollOffset(desired);
    setNewOutput(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice]);

  // Keep the reader's position stable while streaming appends new lines below.
  useEffect(() => {
    const added = chatLines.length - previousLineCountRef.current;
    previousLineCountRef.current = chatLines.length;
    if (added <= 0) return;
    if (viewport.offset > 0) {
      setScrollOffset((previous) => anchorOffset(previous, added, maxScrollRef.current));
      setNewOutput(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatLines.length]);

  useEffect(() => {
    if (viewport.offset === 0) setNewOutput(false);
  }, [viewport.offset]);

  const scrollBy = useCallback((delta) => {
    setScrollOffset((previous) => scrollOffsetBy(previous, delta, maxScrollRef.current));
  }, []);

  function latestReasoningId() {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'assistant' && typeof message.meta?.reasoning === 'string' && message.meta.reasoning.trim()) {
        return message.id ?? null;
      }
    }
    return null;
  }

  function toggleReasoning(target = null) {
    const id = target ?? (liveReasoning?.text ? 'live' : latestReasoningId());
    if (!id) return;
    if (id === 'live') {
      setLiveReasoning((previous) => (previous ? { ...previous, expanded: !previous.expanded } : previous));
      return;
    }
    setExpandedReasoningIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectionItems = useMemo(() => {
    const items = attachments.map((attachment) => ({ kind: 'attachment', id: attachment.id }));
    const reasoningTarget = liveReasoning?.text ? 'live' : latestReasoningId();
    if (reasoningTarget) items.push({ kind: 'reasoning', id: reasoningTarget });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments, liveReasoning, messages]);

  function removeSelectedAttachment() {
    if (selection?.kind !== 'attachment') return false;
    const removed = attachments.find((attachment) => attachment.id === selection.id);
    if (!removed) {
      setSelection(null);
      return false;
    }
    setAttachments((previous) => removeAttachmentById(previous, selection.id));
    setSelection(null);
    setNotice({ text: `Removed ${formatAttachmentCard(removed)}.`, tone: 'info' });
    return true;
  }

  function handleMouseEvent(mouse) {
    if (mouse.wheelUp) {
      scrollBy(4);
      return true;
    }
    if (mouse.wheelDown) {
      scrollBy(-4);
      return true;
    }
    if (mouse.motion || mouse.release) return true;
    // The rail is not a panel and has no hidden actions; taps there do nothing.
    if (railWidth && mouse.x <= railWidth) return true;

    const row = Math.max(0, Math.min(rows - 1, mouse.y - 1));
    if (row >= rows - 1) {
      if (mouse.x <= Math.max(18, columns * 0.33)) openPanel('sessions');
      else if (mouse.x >= columns - Math.max(18, columns * 0.33)) openPanel('models');
      return true;
    }

    // Tap a reasoning header (live or persisted) to expand/collapse it.
    const reasoningLine = lineAtRow({ row, topPadding, lines: visibleLines });
    if (reasoningLine?.reasoningFor) {
      toggleReasoning(reasoningLine.reasoningFor);
      return true;
    }

    // Tap a compact pasted-text card to select it; Esc then removes it.
    const attachmentTop = rows - statusHeight - suggestionsHeight - composerHeight;
    // Skip the top border, then the prompt rows, to land on the first chip.
    const attachmentIndex = row - attachmentTop - 1 - composerLayout.lines.length;
    if (attachmentIndex >= 0 && attachmentIndex < attachmentRowsPreview.items.length) {
      setSelection({ kind: 'attachment', id: attachmentRowsPreview.items[attachmentIndex].id });
      return true;
    }

    setSelection(null);
    return true;
  }

  const submitPromptEntry = () => {
    if (prompt) {
      const value = prompt.value.trim();
      if (prompt.kind === 'key-add-name') {
        if (!value) return;
        // Shown in clear: you cannot spot a swallowed/truncated character in a
        // field full of bullets. The list view is still masked.
        setPrompt({ kind: 'key-add-value', label: `API key for "${value}"`, value: '', cursor: 0, masked: false, name: value });
        return;
      }
      if (prompt.kind === 'key-add-value') {
        try {
          const added = credentials.add({ name: prompt.name, key: value, status: 'unverified' });
          credentials.setActive(added.id);
          // Follow the new key to its provider so the next request is aimed at
          // the service the token really belongs to.
          const switched = envRef.current.runtime.useProvider(added.provider);
          setKeysMessage(
            `Added ${added.name} (${added.masked}, ${value.length} characters) · provider ${added.providerName} detected${switched ? ` · model ${switched.name}` : ''}. Verifying with a real completion…`,
          );
          setPrompt(null);
          // Verify with the same request the agent will send, not a catalogue
          // listing that can succeed for a key chat rejects.
          void verifyKey(added);
        } catch (error) {
          setKeysMessage(error.message);
        }
        return;
      }
      if (prompt.kind === 'key-rename') {
        if (!value) return;
        try {
          const updated = credentials.rename(prompt.targetId, value);
          setKeysMessage(`Renamed to ${updated.name}.`);
          setPrompt(null);
        } catch (error) {
          setKeysMessage(error.message);
        }
        return;
      }
      return;
    }
  };

  /**
   * Verify one key the way it will be used: a real POST /chat/completions with
   * the provider's model. A 429 waits for Retry-After and retries once, so a
   * free-tier key is not marked dead after a momentary rate limit.
   */
  async function verifyKey(entry) {
    if (!entry) return null;
    const key = credentials.reveal(entry.id);
    const providerId = resolveProviderId(entry.provider);
    const model = entry.model || config.modelFor(providerId);
    const label = `${entry.name} · ${providerName(providerId)}`;
    setKeysMessage(`${label}: sending a real completion${model ? ` (${model})` : ''}…`);
    try {
      const provider = createProvider({
        provider: providerId,
        baseUrl: entry.baseUrl || config.baseUrlFor(providerId),
        apiKey: key,
      });
      const result = await provider.validateKey(key, {
        signal: AbortSignal.timeout(60_000),
        model,
        onWait: ({ waitMs, next }) => {
          if (!mountedRef.current) return;
          setKeysMessage(`${label}: rate limited · waiting ${Math.ceil(waitMs / 1000)}s before attempt ${next}…`);
        },
      });
      if (!mountedRef.current) return result;
      if (result.valid) {
        credentials.setStatus(entry.id, 'ready');
        setKeysMessage(
          `${entry.name}: key accepted by ${providerName(providerId)}${model ? ` with ${model}` : ''} · ${result.models?.length ?? 0} models available${result.warning ? ` · ${result.warning}` : ''}.`,
        );
        return result;
      }
      if (result.blocked) {
        // 403 from the provider: the key itself was accepted, the account
        // behind it needs action (TokenHarbor email verification, model access).
        credentials.setStatus(entry.id, 'blocked', result.error?.message);
        setKeysMessage(
          `${entry.name}: key accepted by ${providerName(providerId)}, but the account needs action · ${result.error?.message ?? 'restricted'}`,
        );
        return result;
      }
      if (result.rateLimited) {
        credentials.setStatus(entry.id, 'rate_limited', result.error?.message);
        const seconds = result.retryAfterMs ? Math.ceil(result.retryAfterMs / 1000) : null;
        setKeysMessage(
          `${entry.name}: still rate limited${seconds ? ` · retry in ${seconds}s` : ''}. The key was not rejected — press T again later.`,
        );
        return result;
      }
      if (result.offline) {
        setKeysMessage(`${entry.name}: network unreachable, could not verify.`);
        return result;
      }
      if (result.inconclusive) {
        setKeysMessage(`${entry.name}: provider error, not a key rejection · ${result.error?.message ?? 'unknown'}`);
        return result;
      }
      credentials.setStatus(entry.id, 'invalid', result.error?.message);
      setKeysMessage(`${entry.name}: ${result.error?.message ?? 'invalid'}`);
      return result;
    } catch (error) {
      setKeysMessage(`Test failed: ${error.message}`);
      return null;
    }
  }

  async function testSelectedKey() {
    const keys = credentials.list();
    const entry = keys[Math.min(panelSelection, keys.length - 1)];
    await verifyKey(entry);
  }

  function currentSessionId() {
    try {
      return envRef.current?.session?.id ?? null;
    } catch {
      return null;
    }
  }

  function beginPasteCapture() {
    pasteBatchRef.current?.flush();
    pasteModeRef.current = { active: true, text: '' };
    setPasteCapture({ chars: 0 });
    setSelection(null);
    setNotice({
      text: 'Paste capture active: paste a block, then press Ctrl+D to make one attachment. Enter inserts a newline. Esc cancels.',
      tone: 'info',
    });
  }

  function cancelPasteCapture() {
    pasteModeRef.current = { active: false, text: '' };
    setPasteCapture(null);
    setNotice({ text: 'Paste capture cancelled.', tone: 'info' });
  }

  function appendPasteCapture(text) {
    const capture = pasteModeRef.current;
    if (!capture.active || !text) return;
    capture.text += text;
    setPasteCapture({ chars: [...capture.text].length });
  }

  function finishPasteCapture() {
    const capture = pasteModeRef.current;
    if (!capture.active) return;
    const content = capture.text;
    pasteModeRef.current = { active: false, text: '' };
    setPasteCapture(null);
    if (!content.trim()) {
      setNotice({ text: 'Nothing was captured. Run /paste again and paste the block.', tone: 'warning' });
      return;
    }
    commitPastedContent(content, { force: true });
  }

  function insertComposerText(text, source = 'paste') {
    const next = insertPlainText(input, cursor, text);
    if (!next.changed) return false;
    inputTraceRef.current.composer({ bytes: String(text ?? '').length, source });
    setInput(next.value);
    setCursor(next.cursor);
    setHistoryIndex(null);
    return true;
  }

  function runComposerEscape() {
    // A pending secret confirmation owns Escape first. Panels and dialogs keep
    // priority too: their branches run before this helper is reached.
    if (pendingSendRef.current) {
      pendingSendRef.current = null;
      setNotice(null);
      return;
    }
    const action = escapeAction({
      selectedAttachmentId,
      reasoningSelected,
      hasInput: Boolean(input),
    });
    if (action.type === 'remove-attachment') {
      removeSelectedAttachment();
      return;
    }
    if (action.type === 'collapse-reasoning') {
      if (selection.id === 'live') {
        setLiveReasoning((previous) => (previous ? { ...previous, expanded: false } : previous));
      } else {
        setExpandedReasoningIds((previous) => {
          const next = new Set(previous);
          next.delete(selection.id);
          return next;
        });
      }
      setSelection(null);
      return;
    }
    if (input) {
      setInput('');
      setCursor(0);
    }
    setScrollOffset(0);
    setNewOutput(false);
  }

  /**
   * Bracketed paste for a focused panel prompt (add key, rename). The payload
   * never reaches Ink, so without this it fell through to the hidden chat
   * composer and an API key pasted into "Add key" was silently stored as a
   * chat draft instead of in the key field.
   */
  function insertPromptText(content) {
    const active = promptRef.current;
    if (!active) return false;
    const cleaned = active.masked
      ? normalizeKeyInput(content)
      : sanitizeForDisplay(content).replace(/\s+/g, ' ').trim();
    if (!cleaned) return true;
    setPrompt((current) => {
      if (!current) return current;
      const next = insertPlainText(current.value, current.cursor, cleaned);
      return next.changed ? { ...current, value: next.value, cursor: next.cursor } : current;
    });
    return true;
  }

  function commitPastedContent(content, { batched = false, force = false } = {}) {
    if (!mountedRef.current) return;
    const settings = pasteSettings(config.get());
    inputTraceRef.current.paste({ phase: 'finish', chars: String(content ?? '').length });
    const attach = force ? Boolean(String(content ?? '').trim()) : shouldBecomeAttachment(content, settings);
    if (attach) {
      const attachment = createPastedAttachment(content, { settings, sessionId: currentSessionId() });
      const now = Date.now();
      const previous = lastPasteCommitRef.current;
      // A slow terminal may deliver the next chunk after the quiet timer has
      // already fired. Merge it into the same card instead of creating a
      // second attachment for the same paste.
      if (batched && previous.batched && previous.id && now - previous.at < 1500) {
        const index = attachmentsRef.current.findIndex((entry) => entry.id === previous.id);
        if (index !== -1) {
          const existing = attachmentsRef.current[index];
          const merged = {
            ...createPastedAttachment(`${existing.content}${content}`, {
              settings,
              sessionId: existing.sessionId ?? currentSessionId(),
            }),
            id: existing.id,
            createdAt: existing.createdAt,
          };
          const next = [...attachmentsRef.current];
          next[index] = merged;
          attachmentsRef.current = next.slice(-20);
          setAttachments(attachmentsRef.current);
          inputTraceRef.current.attachment({ id: existing.id, chars: merged.chars });
          lastPasteCommitRef.current = { id: existing.id, at: now, batched: true };
          setNotice({
            text: `Pasted ${formatCount(merged.chars)} characters as a ${merged.language} attachment. Tab selects it, Esc removes the selected card, Ctrl+X removes the last one.`,
            tone: 'info',
          });
          return;
        }
      }
      const next = [...attachmentsRef.current, attachment].slice(-20);
      attachmentsRef.current = next;
      setAttachments(next);
      inputTraceRef.current.attachment({ id: attachment.id, chars: attachment.chars });
      lastPasteCommitRef.current = batched
        ? { id: attachment.id, at: now, batched: true }
        : { id: null, at: 0, batched: false };
      setNotice({
        text: `Pasted ${formatCount(attachment.chars)} characters as a ${attachment.language} attachment. Tab selects it, Esc removes the selected card, Ctrl+X removes the last one.`,
        tone: 'info',
      });
      return;
    }
    lastPasteCommitRef.current = { id: null, at: 0, batched: false };
    const cleaned = sanitizeForDisplay(content).replace(/\t/g, '  ');
    insertComposerText(cleaned);
  }

  // Always call the latest closure: the batcher lives across renders, while
  // commitPastedContent needs the current input/cursor/config.
  pasteCommitRef.current = commitPastedContent;

  // A bracketed block arrives complete from the controller. It becomes exactly
  // one attachment; the composer text that existed before the paste is never
  // touched.
  pasteHandlerRef.current = (content) => {
    if (!mountedRef.current) return;
    setPasteMarkers(true);
    if (!ready) {
      // Setup wizard: it reads the same filtered stream, so hand the content to
      // its focused text field instead of dropping it.
      inputController?.injectText(content);
      return;
    }
    // A focused prompt owns pasted text; the composer is disabled behind it.
    if (insertPromptText(content)) return;
    if (pasteModeRef.current.active) {
      appendPasteCapture(content);
      return;
    }
    // The composer is hidden behind a panel or dialog: committing the payload
    // would file it somewhere the user cannot see (an API key pasted while the
    // key panel was open used to end up as a chat draft).
    if (panel || confirming || approval || errorDialog || permissionWarning) {
      if (panel === 'keys') {
        setKeysMessage('Press A to add a key, then paste into the name/key field.');
      }
      return;
    }
    pasteBatchRef.current.flush();
    commitPastedContent(content);
  };

  /**
   * Terminal without explicit paste boundaries: Ink delivers the read as one
   * event (or several ~4 KB events), which the quiet batcher joins. This path
   * can only be best-effort, and is never used while capture mode is active.
   */
  function handleComposerPaste(inputChar, key = {}) {
    if (!ready) return false;
    if (!inputChar) return false;
    if (key.return) return false;
    const composerActive = !panel && !prompt && !confirming && !approval && !errorDialog && !permissionWarning;
    if (!composerActive) return false;
    // Mouse reports look like escape sequences; let the mouse handler see them.
    if (parseSgrMouse(inputChar)) return false;

    const hasControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(inputChar);
    if (hasControl) {
      // A multi-character chunk with ANSI bytes is a non-bracketed paste; keep
      // it as data instead of letting its escape sequences drive shortcuts.
      if (inputChar.length > 1 && inputChar.includes('\n')) {
        pasteBatchRef.current.flush();
        commitPastedContent(inputChar);
        return true;
      }
      return false;
    }

    const batcher = pasteBatchRef.current;
    // Short slash commands reach the editor before the quiet timer so `/paste`
    // followed immediately by Enter works on the first press.
    if (inputChar.startsWith('/') && inputChar.length <= 64 && !inputChar.includes('\n')) return false;
    // A burst already in progress owns even a short tail read: the last chunk
    // of a paste can be only a few characters long.
    if (batcher.pending) {
      batcher.feed(inputChar);
      return true;
    }
    // Any multi-character read starts a short burst. Single keystrokes go
    // straight to the editor, so typing stays responsive.
    if (inputChar.length > 1 || inputChar.includes('\n')) {
      batcher.feed(inputChar);
      return true;
    }
    return false;
  }

  async function refreshModels() {
    const entry = credentials.activeEntry();
    const providerId = resolveProviderId(entry?.provider ?? config.providerId);
    setModelsMessage(`Fetching model catalogue from ${providerName(providerId)}…`);
    try {
      if (!entry) {
        setModelsMessage('No API key configured. Open /keys to add one.');
        return;
      }
      const provider = createProvider({
        provider: providerId,
        baseUrl: entry.baseUrl || config.baseUrlFor(providerId),
        apiKey: entry.key,
      });
      const ids = await provider.listModels({ signal: AbortSignal.timeout(20_000) });
      if (!mountedRef.current) return;
      envRef.current.runtime.models.applyCatalogue(ids, { provider: providerId });
      setModelsMessage(
        `Catalogue checked: ${ids.length} models visible to this ${providerName(providerId)} key.`,
      );
    } catch (error) {
      if (!mountedRef.current) return;
      setModelsMessage(`Could not refresh: ${error.message}`);
    }
  }

  useInput((inputChar, key) => {
    const rawInput = inputController?.takeRaw() ?? null;
    inputTraceRef.current.feed({
      state: 'ink',
      inputBytes: inputChar?.length ?? 0,
      hasRaw: rawInput !== null,
    });
    if (!ready) return;

    // Explicit paste capture (`/paste`): every normal key is content, not a
    // shortcut. Complete bracketed blocks arrive through pasteHandlerRef.
    if (pasteModeRef.current.active) {
      if (key.escape) {
        cancelPasteCapture();
        return;
      }
      if (key.ctrl && inputChar === 'd') {
        finishPasteCapture();
        return;
      }
      if (key.ctrl && inputChar === 'c') {
        cancelPasteCapture();
        return;
      }
      if (key.return) {
        appendPasteCapture('\n');
        return;
      }
      if (inputChar && !key.ctrl) appendPasteCapture(inputChar);
      return;
    }

    // Fallback only for terminals without bracketed paste markers. Bracketed
    // blocks never reach Ink, because the input controller removes them first.
    if (handleComposerPaste(inputChar, key)) return;

    if (inputChar) {
      const mouse = parseSgrMouse(inputChar);
      if (mouse) {
        if (mouseOn) handleMouseEvent(mouse);
        return;
      }
    }

    if (key.ctrl && inputChar === 'c') {
      if (approval) answerApproval(false);
      if (busyRef.current) {
        abortRef.current?.abort();
        addActivity('Cancelling…');
      } else {
        exit();
      }
      return;
    }

    if (approval) {
      if (inputChar.toLowerCase() === 'a' || key.return) answerApproval(true);
      else if (inputChar.toLowerCase() === 'd' || key.escape) answerApproval(false);
      return;
    }

    if (errorDialog) {
      if (inputChar.toLowerCase() === 'r' && errorDialog.canRetry) retryLastPrompt();
      else if (inputChar.toLowerCase() === 'k' && errorDialog.canChangeKey) {
        setErrorDialog(null);
        openPanel('keys');
      } else if (key.escape || key.return) setErrorDialog(null);
      return;
    }

    if (permissionWarning) {
      if (inputChar.toLowerCase() === 'y') {
        applyPermission(permissionWarning.key, permissionWarning.value);
        setPermissionWarning(null);
      } else if (inputChar.toLowerCase() === 'n' || key.escape) {
        setPermissionWarning(null);
      }
      return;
    }

    if (prompt) {
      if (key.return) {
        submitPromptEntry();
        return;
      }
      if (key.escape) {
        setPrompt(null);
        return;
      }
      const next = applyTextInput(prompt.value, prompt.cursor, inputChar, key, rawInput);
      if (next.changed) setPrompt({ ...prompt, value: next.value, cursor: next.cursor });
      return;
    }

    if (confirming) {
      if (inputChar.toLowerCase() === 'y') {
        if (confirming.kind === 'session-delete') {
          const current = envRef.current;
          const wasCurrent = current.session.id === confirming.id;
          current.session.delete(confirming.id);
          if (wasCurrent) newSession();
          setSessions(current.session.list());
          setMessages([...current.session.messages]);
        } else if (confirming.kind === 'key-delete') {
          try {
            credentials.remove(confirming.id);
            setKeysMessage(`Deleted ${confirming.name}.`);
          } catch (error) {
            setKeysMessage(error.message);
          }
        }
        setConfirming(null);
        setPanelSelection((value) => Math.max(0, value - 1));
      } else if (inputChar.toLowerCase() === 'n' || key.escape) {
        setConfirming(null);
      }
      return;
    }

    if (panel) {
      const handleListMove = (delta, length) => {
        if (!length) return;
        setPanelSelection((value) => (value + delta + length) % length);
      };

      if (key.escape) {
        closePanel();
        return;
      }

      if (panel === 'sessions') {
        if (key.upArrow) handleListMove(-1, sessions.length);
        else if (key.downArrow) handleListMove(1, sessions.length);
        else if (key.return && sessions.length) {
          openSession(sessions[Math.min(panelSelection, sessions.length - 1)].id);
        } else if (inputChar.toLowerCase() === 'n') {
          newSession();
          setPanel(null);
        } else if (inputChar.toLowerCase() === 'd' && sessions.length) {
          const target = sessions[Math.min(panelSelection, sessions.length - 1)];
          setConfirming({ kind: 'session-delete', id: target.id, title: target.title });
        }
        return;
      }

      if (panel === 'models') {
        const all = modelsForPanel();
        if (key.upArrow) handleListMove(-1, all.length);
        else if (key.downArrow) handleListMove(1, all.length);
        else if (key.return && all.length) {
          const entry = all[Math.min(panelSelection, all.length - 1)];
          envRef.current.runtime.setModel(entry.id);
          setSessions(envRef.current.session.list());
          setNotice({
            text: `Model: ${entry.name} · ${providerName(entry.provider)} key ${credentials.activeEntry()?.name ?? 'none'}`,
            tone: 'info',
          });
          closePanel();
        } else if (inputChar.toLowerCase() === 'r') refreshModels();
        return;
      }

      if (panel === 'keys') {
        const all = credentials.list();
        if (key.upArrow) handleListMove(-1, all.length);
        else if (key.downArrow) handleListMove(1, all.length);
        else if ((key.return || inputChar.toLowerCase() === 's') && all.length) {
          const target = all[Math.min(panelSelection, all.length - 1)];
          credentials.setActive(target.id);
          const switched = envRef.current.runtime.useProvider(target.provider);
          setKeysMessage(
            switched
              ? `Active key: ${target.name} · ${providerName(target.provider)} · model ${switched.name} · used for the next request, then automatic selection resumes.`
              : `Active key: ${target.name}, but ${providerName(target.provider)} has no known model. Add one in config.json → "models".`,
          );
        } else if (inputChar.toLowerCase() === 'a') {
          setKeysMessage(null);
          setPrompt({ kind: 'key-add-name', label: 'Key name', value: '', cursor: 0, masked: false });
        } else if (inputChar.toLowerCase() === 't') testSelectedKey();
        else if (inputChar.toLowerCase() === 'r' && all.length) {
          const target = all[Math.min(panelSelection, all.length - 1)];
          setPrompt({
            kind: 'key-rename',
            label: `New name for ${target.name}`,
            value: target.name,
            cursor: target.name.length,
            masked: false,
            targetId: target.id,
          });
        } else if (inputChar.toLowerCase() === 'd' && all.length) {
          const target = all[Math.min(panelSelection, all.length - 1)];
          setConfirming({ kind: 'key-delete', id: target.id, name: target.name });
        }
        return;
      }

      if (panel === 'settings') {
        const rowsList = SETTINGS_ROW_KEYS;
        if (key.upArrow) handleListMove(-1, rowsList.length);
        else if (key.downArrow) handleListMove(1, rowsList.length);
        else if (key.return) {
          const rowKey = rowsList[Math.min(panelSelection, rowsList.length - 1)];
          if (rowKey === 'unattended') {
            // One switch for the whole point: leave the agent alone.
            const on = ['shell', 'fileWrite', 'sensitiveRead'].every(
              (field) => config.get().permissions[field] === 'auto',
            );
            requestPermission('all', on ? 'ask' : 'auto');
            return;
          }
          const currentValue = config.get().permissions[rowKey];
          const nextValue = currentValue === 'allow' ? 'auto' : currentValue === 'auto' ? 'ask' : 'allow';
          const permissionKey = rowKey === 'shell' ? 'shell' : rowKey === 'fileWrite' ? 'file' : 'sensitive';
          requestPermission(permissionKey, nextValue);
        }
        return;
      }

      if (panel === 'projects') {
        if (key.upArrow) handleListMove(-1, projects.length);
        else if (key.downArrow) handleListMove(1, projects.length);
        else if (key.return && projects.length) {
          const target = projects[Math.min(panelSelection, projects.length - 1)];
          try {
            envRef.current.runtime.focusProject(target.relPath);
            setNotice({ text: `Focused ${target.relPath}`, tone: 'info' });
          } catch (error) {
            setNotice({ text: error.message, tone: 'error' });
          }
          closePanel();
        } else if (inputChar.toLowerCase() === 'a') {
          envRef.current.runtime.focusProject('all');
          closePanel();
          setNotice({ text: 'Project focus cleared.', tone: 'info' });
        } else if (inputChar.toLowerCase() === 'r') {
          const scan = envRef.current.runtime.scanProjects({ force: true });
          setProjects(scan.projects);
          setProjectMeta({ truncated: scan.truncated, durationMs: scan.durationMs });
          setPanelSelection(0);
        }
        return;
      }
      return;
    }

    // Global shortcuts available while typing.
    if (key.ctrl && inputChar === 'x' && attachments.length) {
      const removed = attachments[attachments.length - 1];
      setAttachments((previous) => removeAttachmentById(previous, removed.id));
      setSelection((current) => (current?.kind === 'attachment' && current.id === removed.id ? null : current));
      setNotice({ text: `Removed ${formatAttachmentCard(removed)}.`, tone: 'info' });
      return;
    }
    if (key.ctrl && inputChar === 'r') {
      toggleReasoning();
      return;
    }
    if (key.ctrl && (inputChar === 'j' || inputChar === 'J')) {
      const next = insertPlainText(input, cursor, '\n');
      if (next.changed) {
        setInput(next.value);
        setCursor(next.cursor);
        setHistoryIndex(null);
      }
      return;
    }
    if (key.ctrl && key.home) {
      setScrollOffset(maxScrollRef.current);
      setNewOutput(false);
      return;
    }
    if (key.ctrl && key.end) {
      setScrollOffset(0);
      setNewOutput(false);
      return;
    }
    if (key.ctrl && inputChar === 'n') {
      if (busyRef.current) setNotice({ text: 'Cancel the running turn first (Ctrl+C).', tone: 'warning' });
      else newSession();
      return;
    }
    if (key.ctrl && inputChar === 'l') {
      try {
        stdout?.write('\u001b[2J\u001b[H');
      } catch {
        /* ignore */
      }
      setViewFromId(messages.length ? messages[messages.length - 1].id : null);
      setNotice(null);
      return;
    }
    if (key.meta && key.leftArrow) {
      openPanel('sessions');
      return;
    }
    if (key.meta && key.rightArrow) {
      openPanel('models');
      return;
    }
    if (key.pageUp) {
      scrollBy(Math.max(1, chatHeight - 1));
      return;
    }
    if (key.pageDown) {
      scrollBy(-Math.max(1, chatHeight - 1));
      return;
    }
    if (key.tab) {
      // With attachment/reasoning cards present, Tab moves the selection. A
      // slash command still owns Tab so completion keeps working while typing.
      if (selectionItems.length && !input.startsWith('/')) {
        setSelection((current) => cycleSelection(current, selectionItems, key.shift ? -1 : 1));
        return;
      }
      const completed = completeCommand(input);
      if (completed) {
        setInput(completed);
        setCursor(completed.length);
      }
      return;
    }

    if (key.return) {
      // A non-bracketed paste may still be batching. Commit it and require a
      // second Enter, otherwise sendPrompt would read the pre-commit state.
      if (pasteBatchRef.current.pending) {
        pasteBatchRef.current.flush();
        return;
      }
      if (pendingSendRef.current) {
        const pending = pendingSendRef.current;
        pendingSendRef.current = null;
        setNotice(null);
        sendPrompt(pending.text, { attachments: pending.attachments, confirmedSecrets: true });
        return;
      }
      // Enter submits; Alt/Shift/Ctrl+Enter inserts a newline for multiline prompts.
      if (key.shift || key.meta || key.ctrl) {
        const next = insertPlainText(input, cursor, '\n');
        if (next.changed) {
          setInput(next.value);
          setCursor(next.cursor);
          setHistoryIndex(null);
        }
        return;
      }
      sendPrompt(input);
      return;
    }

    if (key.upArrow || key.downArrow) {
      if (input.includes('\n')) {
        const next = moveCursorVertical(input, cursor, key.upArrow ? -1 : 1);
        if (next.changed) setCursor(next.cursor);
        return;
      }
      if (history.length === 0) return;
      if (historyIndex === null && input !== '') return;
      const nextIndex =
        historyIndex === null
          ? (key.upArrow ? history.length - 1 : null)
          : key.upArrow
            ? Math.max(0, historyIndex - 1)
            : historyIndex + 1 >= history.length ? null : historyIndex + 1;
      setHistoryIndex(nextIndex);
      const nextValue = nextIndex === null ? '' : history[nextIndex];
      setInput(nextValue);
      setCursor(nextValue.length);
      return;
    }

    // Panels open on an empty input; cursor movement is preserved while typing.
    if (key.leftArrow && input.length === 0) {
      openPanel('sessions');
      return;
    }
    if (key.rightArrow && input.length === 0) {
      openPanel('models');
      return;
    }

    if (key.escape) {
      runComposerEscape();
      return;
    }

    const next = applyTextInput(input, cursor, inputChar, key, rawInput);
    if (next.changed) {
      setInput(next.value);
      setCursor(next.cursor);
      setHistoryIndex(null);
    }
  });

  const unattendedWarning = permissionWarning?.value === 'auto';
  const permissionConfirm = permissionWarning
    ? h(
        Box,
        { borderStyle: 'round', borderColor: unattendedWarning ? theme.red : theme.yellow, flexDirection: 'column', paddingX: 1 },
        h(
          Text,
          { color: unattendedWarning ? theme.red : theme.yellow, bold: true },
          unattendedWarning ? 'ENABLE UNATTENDED MODE?' : 'ENABLE ALWAYS ALLOW?',
        ),
        unattendedWarning
          ? h(Text, { color: theme.text }, 'Shell commands of any risk (rm -rf, sudo, installers, network), file writes and sensitive reads will run without asking.')
          : h(Text, { color: theme.text }, 'Read-only and project commands will run without approval.'),
        unattendedWarning
          ? h(Text, { color: theme.text }, 'You can keep working or walk away; Ctrl+C still cancels the current turn.')
          : h(Text, { color: theme.text }, 'Destructive, installer, network and opaque commands still ask.'),
        isRootUser()
          ? h(Text, { color: theme.red }, 'Agent is running as root: auto-executed commands have full system privileges.')
          : null,
        h(
          Box,
          { marginTop: 1 },
          h(Text, { color: theme.green, bold: true }, '[Y] Enable'),
          h(Text, { color: theme.dim }, '   [N] Cancel'),
        ),
      )
    : null;

  if (dialogActive) {
    const dialogFocus = envRef.current.workspace.focusedPath;
    const dialogRoot = envRef.current.workspace.root;
    const dialogModel = envRef.current.runtime.modelName();
    const dialogWorkspace = dialogFocus
      ? `${dialogRoot}${dialogFocus === dialogRoot ? '' : ` (${dialogFocus.replace(`${dialogRoot}/`, '')})`}`
      : dialogRoot;
    const dialog = approval
      ? h(ApprovalDialog, { request: approval, width: columns, maxHeight: Math.max(10, rows - 9) })
      : errorDialog
        ? h(ErrorDialog, {
            error: errorDialog.error,
            width: columns,
            canRetry: errorDialog.canRetry,
            canChangeKey: errorDialog.canChangeKey,
          })
        : permissionConfirm;
    return h(
      Box,
      { flexDirection: 'column', height: rows, width: columns },
      h(Header, {
        model: dialogModel,
        workspace: dialogWorkspace,
        provider: providerName(envRef.current.runtime.providerId),
        session: envRef.current.session.title,
        status: errorDialog ? 'ERROR' : busy ? phaseStatusLabel(phase) : 'READY',
        statusColor: errorDialog
          ? theme.red
          : phase === PHASES.WAITING_APPROVAL
            ? theme.yellow
            : busy
              ? theme.accent
              : theme.green,
        compact: true,
        width: columns,
      }),
      h(
        Box,
        { flexGrow: 1, flexDirection: 'column', paddingX: 1, marginTop: 1, overflow: 'hidden' },
        dialog,
      ),
      h(StatusBar, {
        model: dialogModel,
        workspace: dialogWorkspace,
        provider: providerName(envRef.current.runtime.providerId),
        permission: config.get().permissions.shell,
        busy,
        frame,
        elapsedMs,
        lastActivity: activities.length ? activities[activities.length - 1].text : null,
        width: columns,
        panel: null,
        compact: true,
        sessionTitle: null,
        tokenTotal,
        phase,
      }),
    );
  }

  if (!ready) {
    return h(SetupWizard, {
      config,
      credentials,
      initialWorkspace,
      initialModel,
      version,
      width: columns,
      height: rows,
      onComplete: ({ workspace, modelId }) => {
        try {
          const previous = envRef.current;
          // The pre-setup environment may have created an empty session; drop it
          // so the first real session is the one the user configured.
          if (previous.session.id && previous.session.messages.length === 0) {
            previous.session.delete(previous.session.id);
          }
          previous.session.close();
        } catch {
          /* ignore */
        }
        const next = createEnvironment({ config, credentials, workspace, modelId, restore: false });
        envRef.current = next;
        holder && (holder.env = next);
        setMessages([...next.session.messages]);
        setSessions(next.session.list());
        setProjects([]);
        setPanel(null);
        resetComposerCards();
        setNotice({ text: `Ready. Workspace ${workspace.root} · model ${next.runtime.modelName(modelId)}`, tone: 'info' });
        setReady(true);
        setEnvVersion((value) => value + 1);
        try {
          next.runtime.scanProjects();
        } catch {
          /* ignore */
        }
      },
    });
  }

  const permissions = config.get().permissions;
  const modelLabel = envRef.current.runtime.modelName();
  const focus = envRef.current.workspace.focusedPath;
  const workspaceLabel = focus
    ? `${envRef.current.workspace.root}${focus === envRef.current.workspace.root ? '' : ` (${focus.replace(`${envRef.current.workspace.root}/`, '')})`}`
    : envRef.current.workspace.root;
  const lastActivity = activities.length ? activities[activities.length - 1].text : null;

  let contentRegion;
  if (panel === 'sessions') {
    contentRegion = h(
      Box,
      { height: chatHeight, flexShrink: 0, paddingX: 1 },
      h(SessionsPanel, {
        sessions,
        selected: Math.min(panelSelection, Math.max(0, sessions.length - 1)),
        currentId: envRef.current.session.id,
        width: mainWidth - 4,
        confirming,
      }),
    );
  } else if (panel === 'models') {
    contentRegion = h(
      Box,
      { height: chatHeight, flexShrink: 0, paddingX: 1 },
      h(ModelsPanel, {
        models: modelsForPanel(),
        selected: Math.min(panelSelection, Math.max(0, modelsForPanel().length - 1)),
        activeId: envRef.current.runtime.activeModel,
        width: mainWidth - 4,
        statusMessage: modelsMessage,
        refreshError: null,
      }),
    );
  } else if (panel === 'keys') {
    contentRegion = h(
      Box,
      { height: chatHeight, flexShrink: 0, paddingX: 1 },
      h(KeysPanel, {
        keys: credentials.list(),
        selected: Math.min(panelSelection, Math.max(0, credentials.list().length - 1)),
        width: mainWidth - 4,
        prompt,
        testMessage: keysMessage,
        confirming,
      }),
    );
  } else if (panel === 'settings') {
    contentRegion = h(
      Box,
      { height: chatHeight, flexShrink: 0, paddingX: 1 },
      h(SettingsPanel, {
        permissions,
        selected: Math.min(panelSelection, SETTINGS_ROW_KEYS.length - 1),
        width: mainWidth - 4,
        rootWarning: isRootUser(),
        confirming: permissionWarning,
      }),
    );
  } else if (panel === 'projects') {
    contentRegion = h(
      Box,
      { height: chatHeight, flexShrink: 0, paddingX: 1 },
      h(ProjectsPanel, {
        projects,
        selected: Math.min(panelSelection, Math.max(0, projects.length - 1)),
        width: mainWidth - 4,
        focused: focus,
        truncated: projectMeta.truncated,
        durationMs: projectMeta.durationMs,
      }),
    );
  } else {
    contentRegion = h(
      Box,
      { flexDirection: 'column', height: chatHeight, flexShrink: 0, paddingX: 1, overflow: 'hidden' },
      ...Array.from({ length: topPadding }, (_, index) => h(Text, { key: `pad-${index}` }, ' ')),
      ...visibleLines.map((line, index) =>
        h(
          Text,
          {
            key: `line-${startLine}-${index}`,
            color: line.color,
            dim: line.dim,
            bold: line.bold,
            wrap: 'truncate',
          },
          line.text || ' ',
        ),
      ),
    );
  }

  const mainColumn = h(
    Box,
    { flexDirection: 'column', height: rows, width: mainWidth, flexShrink: 0 },
    contentRegion,
    showActivity
      ? h(ActivityEngine, {
          frame,
          elapsedMs,
          activities,
          width: mainWidth,
          phase,
          maxActivities: activityLimit,
        })
      : null,
    h(PromptInput, {
      value: input,
      cursor,
      width: mainWidth,
      selectedAttachmentId,
      maxLines: composerTextRows,
      captureActive: Boolean(pasteCapture),
      placeholder:
        panel === 'keys'
          ? 'Esc to close keys'
          : panel
            ? 'Esc to close the panel'
            : pasteCapture
              ? `Paste capture · ${formatCount(pasteCapture.chars)} chars · Ctrl+D attach · Esc cancel`
              : busy
                ? 'Type while the agent works…'
                : 'Ask MikuHost anything…  (/help for commands)',
      disabled: Boolean(panel) || Boolean(prompt),
      busy,
      attachments,
      rows,
    }),
    suggestionsHeight
      ? h(
          Text,
          { color: theme.faint, wrap: 'truncate' },
          `  ${suggestions.map((command) => command.usage).join('   ')}`,
        )
      : null,
    h(StatusBar, {
      model: modelLabel,
      workspace: workspaceLabel,
      provider: providerName(envRef.current.runtime.providerId),
      permission: permissions.shell,
      busy,
      frame,
      elapsedMs,
      lastActivity,
      width: mainWidth,
      panel,
      compact,
      tiny,
      newOutput,
      attachmentCount: attachments.length,
      attachmentSelected: Boolean(selectedAttachmentId),
      captureActive: Boolean(pasteCapture),
      pasteMarkers,
      divider: false,
      sessionTitle: envRef.current.session.title,
      tokenTotal,
      phase,
    }),
  );

  return h(
    Box,
    { flexDirection: 'row', height: rows, width: columns },
    railWidth
      ? h(Sidebar, {
          width: railWidth,
          height: rows,
          title: envRef.current.session.title,
          messageCount: messages.length,
          model: modelLabel,
          provider: providerName(envRef.current.runtime.providerId),
          workspace: workspaceLabel,
          permission: permissions.shell,
          tokenTotal,
          tools: railTools,
        })
      : null,
    mainColumn,
  );
}

export async function launchTui({
  config,
  workspace,
  initialModel = null,
  version = null,
  restore = false,
  sessionId = null,
}) {
  const credentials = new CredentialManager();
  // A token found in the environment is enough to start: the wizard is only
  // needed when no credential exists at all.
  const needsSetup = credentials.size === 0;
  const initialEnv = createEnvironment({
    config,
    credentials,
    workspace,
    modelId: initialModel,
    restore,
    sessionId,
  });
  const holder = { env: initialEnv };
  const inputTrace = createInputTrace();
  // One owner of stdin: the controller strips paste blocks before Ink sees
  // them, and Ink reads the filtered stream instead of process.stdin.
  const inputController = new InputController({ stdin: process.stdin, trace: inputTrace });
  inputController.start();
  const app = render(
    h(App, {
      config,
      credentials,
      initialEnv,
      needsSetup,
      initialWorkspace: workspace,
      initialModel,
      version,
      holder,
      inputController,
      inputTrace,
    }),
    { exitOnCtrlC: false, stdin: inputController.input },
  );
  try {
    await app.waitUntilExit();
  } finally {
    inputController.stop();
    try {
      // Lazy persistence: exiting an unused session must not leave an empty row.
      holder.env.session.discardIfEmpty();
      holder.env.session.close();
    } catch {
      /* ignore */
    }
    for (const sequence of [MOUSE_DISABLE, BRACKETED_PASTE_DISABLE]) {
      try {
        process.stdout.write(sequence);
      } catch {
        /* ignore */
      }
    }
  }
  return 0;
}
