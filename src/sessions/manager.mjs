// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import { openSessionStore, newSessionId } from './database.mjs';
import { titleFromPrompt } from '../util/text.mjs';

export class SessionManager {
  constructor({ store, config, model = null, workspace = null } = {}) {
    this.store = store ?? openSessionStore();
    this.config = config ?? null;
    this.model = model;
    this.workspace = workspace;
    this.session = null;
    this.messages = [];
  }

  get kind() {
    return this.store.kind;
  }

  list(limit = 30) {
    return this.store.listSessions(limit);
  }

  /**
   * Remove sessions that never received a message (crashed startup, abandoned
   * "New Session"). Runs at startup and when the current empty session is
   * replaced, so the history list stays useful.
   */
  cleanupEmptySessions({ keepId = null } = {}) {
    let removed = 0;
    for (const session of this.store.listSessions(1000)) {
      if (Number(session.messageCount ?? 0) === 0 && session.id !== keepId) {
        if (this.store.deleteSession(session.id)) removed += 1;
      }
    }
    return removed;
  }

  /** Delete the current session only if it has no messages. */
  discardIfEmpty(id = this.session?.id) {
    if (!id || id !== this.session?.id) return false;
    if (this.messages.length > 0) return false;
    const deleted = this.store.deleteSession(id);
    if (deleted) {
      this.session = null;
      this.messages = [];
    }
    return deleted;
  }

  /** Restore the last session for this workspace, or the most recent one. */
  restoreLast() {
    const preferredId = this.config?.get?.().lastSessionId;
    let session = preferredId ? this.store.getSession(preferredId) : null;
    if (!session) {
      const sessions = this.list(1);
      session = sessions[0] ?? null;
    }
    if (!session) return null;
    return this.open(session.id);
  }

  open(id) {
    const session = this.store.getSession(id);
    if (!session) return null;
    this.session = session;
    this.messages = this.store.getMessages(id);
    if (this.config && this.config.get().lastSessionId !== id) {
      try {
        this.config.setValue('lastSessionId', id);
      } catch {
        /* config write failures must not block the session */
      }
    }
    return this.session;
  }

  create({ title = 'New Session', model = this.model, workspace = this.workspace, project = null } = {}) {
    const session = this.store.createSession({
      id: newSessionId(),
      title,
      model,
      workspace,
      project,
    });
    this.session = session;
    this.messages = [];
    if (this.config) {
      try {
        this.config.setValue('lastSessionId', session.id);
      } catch {
        /* ignore */
      }
    }
    return session;
  }

  ensure({ model = this.model, workspace = this.workspace, project = null } = {}) {
    if (this.session) return this.session;
    return this.create({ model, workspace, project });
  }

  get id() {
    return this.session?.id ?? null;
  }

  get title() {
    return this.session?.title ?? 'New Session';
  }

  appendMessage({ role, content = '', toolName = null, meta = null }) {
    this.ensure();
    const stored = this.store.appendMessage(this.session.id, { role, content, toolName, meta });
    this.messages.push(stored);
    if (role === 'user' && this.session.title === 'New Session') {
      this.rename(titleFromPrompt(content));
    } else {
      this.session = this.store.getSession(this.session.id) ?? this.session;
    }
    return stored;
  }

  /**
   * Destructive rewrite of the stored transcript (new ids for every row).
   * Compaction must NOT use this: it builds a context view per request instead,
   * so the conversation a user can scroll back through is never shortened.
   */
  replaceMessages(messages) {
    if (!this.session) return [];
    this.messages = this.store.replaceMessages(this.session.id, messages);
    return this.messages;
  }

  rename(title) {
    if (!this.session) return null;
    const clean = String(title ?? '').trim();
    if (!clean) return this.session;
    this.session = this.store.updateSession(this.session.id, { title: clean.slice(0, 120) });
    return this.session;
  }

  setModel(model) {
    if (!this.session) {
      this.model = model;
      return null;
    }
    this.model = model;
    this.session = this.store.updateSession(this.session.id, { model });
    return this.session;
  }

  setProject(project) {
    if (!this.session) return null;
    this.session = this.store.updateSession(this.session.id, { project });
    return this.session;
  }

  setWorkspace(workspace) {
    if (!this.session) return null;
    this.session = this.store.updateSession(this.session.id, { workspace });
    return this.session;
  }

  clearMessages() {
    if (!this.session) return;
    this.store.clearMessages(this.session.id);
    this.messages = [];
  }

  delete(id = this.session?.id) {
    if (!id) return false;
    const deleted = this.store.deleteSession(id);
    if (id === this.session?.id) {
      this.session = null;
      this.messages = [];
    }
    return deleted;
  }

  close() {
    try {
      this.store.close();
    } catch {
      /* ignore */
    }
  }
}
