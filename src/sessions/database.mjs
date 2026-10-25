import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { paths, ensureConfigDir } from '../config/paths.mjs';
import { readJson, writeJsonAtomic } from '../util/atomic.mjs';
import { redactSecrets } from '../util/text.mjs';

const require = createRequire(import.meta.url);

/**
 * node:sqlite prints an ExperimentalWarning on first load. It is expected here
 * (we use the built-in module deliberately, with a JSON fallback), and printing
 * it on top of the interactive TUI would corrupt the frame — so filter only
 * that one warning instead of muting all Node warnings.
 */
if (!process.__mikuhostSqliteWarningFiltered) {
  process.__mikuhostSqliteWarningFiltered = true;
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function filteredEmitWarning(warning, ...args) {
    const text = typeof warning === 'string' ? warning : warning?.message ?? '';
    if (/SQLite is an experimental/i.test(text)) return;
    return originalEmitWarning.call(process, warning, ...args);
  };
}

export function newSessionId() {
  return `s_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function safeText(value, max = 200_000) {
  return redactSecrets(String(value ?? '')).slice(0, max);
}

function safeAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object' || typeof attachment.content !== 'string') return null;
  return {
    id: String(attachment.id ?? '').slice(0, 80),
    kind: attachment.kind === 'pasted_text' ? 'pasted_text' : String(attachment.kind ?? 'pasted_text').slice(0, 40),
    name: String(attachment.name ?? 'Pasted text').slice(0, 120),
    language: String(attachment.language ?? 'Text').slice(0, 40),
    chars: Number(attachment.chars) || 0,
    lines: Number(attachment.lines) || 0,
    preview: redactSecrets(String(attachment.preview ?? '')).slice(0, 1000),
    createdAt: Number(attachment.createdAt) || Date.now(),
    // Source code must reach the model intact; never redact or silently trim it.
    // The session store itself is mode 0600 and API keys are still excluded from
    // metadata by key name below.
    content: attachment.content.slice(0, 1_000_000),
  };
}

function safeMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (['apiKey', 'key', 'authorization', 'credential', 'token'].includes(key)) continue;
    if (value === undefined) continue;
    if (key === 'attachments') {
      if (!Array.isArray(value)) continue;
      const attachments = value.map(safeAttachment).filter(Boolean).slice(0, 20);
      if (attachments.length) out.attachments = attachments;
      continue;
    }
    // Reasoning panels are larger than ordinary metadata; keep enough of the
    // provider's text to be useful after a restart without unbounded growth.
    const limit = key === 'reasoning' ? 20_000 : 4000;
    out[key] = typeof value === 'string' ? redactSecrets(value).slice(0, limit) : value;
  }
  return Object.keys(out).length ? out : null;
}

function rowToMessage(row) {
  return {
    id: String(row.id),
    role: row.role,
    content: row.content ?? '',
    toolName: row.tool_name ?? null,
    meta: row.meta ? safeJsonParse(row.meta) : null,
    createdAt: Number(row.created_at),
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function rowToSession(row) {
  return {
    id: row.id,
    title: row.title,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    model: row.model ?? null,
    workspace: row.workspace ?? null,
    project: row.project ?? null,
    messageCount: row.message_count !== undefined ? Number(row.message_count) : undefined,
  };
}

/** SQLite implementation backed by Node's built-in node:sqlite (no native build). */
export class SqliteSessionStore {
  constructor(file = paths.sessions()) {
    ensureConfigDir();
    const { DatabaseSync } = require('node:sqlite');
    this.kind = 'sqlite';
    this.file = file;
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
    } catch {
      /* WAL is an optimisation, not a requirement */
    }
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        model TEXT,
        workspace TEXT,
        project TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_name TEXT,
        meta TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
    `);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* ignore */
    }
  }

  listSessions(limit = 50) {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s ORDER BY s.updated_at DESC LIMIT ?`,
      )
      .all(limit);
    return rows.map(rowToSession);
  }

  getSession(id) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return row ? rowToSession(row) : null;
  }

  createSession({ id = newSessionId(), title = 'New Session', model = null, workspace = null, project = null } = {}) {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (id, title, created_at, updated_at, model, workspace, project) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, safeText(title, 200), now, now, model, workspace, project);
    return this.getSession(id);
  }

  updateSession(id, patch = {}) {
    const existing = this.getSession(id);
    if (!existing) return null;
    const next = {
      title: patch.title !== undefined ? safeText(patch.title, 200) : existing.title,
      model: patch.model !== undefined ? patch.model : existing.model,
      workspace: patch.workspace !== undefined ? patch.workspace : existing.workspace,
      project: patch.project !== undefined ? patch.project : existing.project,
      updatedAt: patch.touch === false ? existing.updatedAt : Date.now(),
    };
    this.db
      .prepare('UPDATE sessions SET title = ?, model = ?, workspace = ?, project = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.model, next.workspace, next.project, next.updatedAt, id);
    return this.getSession(id);
  }

  deleteSession(id) {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  appendMessage(sessionId, { role, content = '', toolName = null, meta = null } = {}) {
    const now = Date.now();
    const metaJson = safeMeta(meta) ? JSON.stringify(safeMeta(meta)) : null;
    const result = this.db
      .prepare('INSERT INTO messages (session_id, role, content, tool_name, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, role, safeText(content), toolName, metaJson, now);
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
    return { id: String(result.lastInsertRowid), role, content: safeText(content), toolName, meta: safeMeta(meta), createdAt: now };
  }

  getMessages(sessionId, { limit = 500 } = {}) {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ?')
      .all(sessionId, limit);
    return rows.map(rowToMessage);
  }

  replaceMessages(sessionId, messages = []) {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    for (const message of messages) this.appendMessage(sessionId, message);
    return this.getMessages(sessionId);
  }

  clearMessages(sessionId) {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId);
  }

  count() {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM sessions').get();
    return Number(row?.c ?? 0);
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * JSON fallback used when node:sqlite is unavailable (older Node, unusual
 * builds). Same interface, atomic full-file writes; the database is small
 * enough (messages per session) for this to be practical.
 */
export class JsonSessionStore {
  constructor(file = paths.sessionsFallback()) {
    ensureConfigDir();
    this.kind = 'json';
    this.file = file;
    this.data = readJson(file, { version: 1, sessions: [], messages: [] }) ?? { version: 1, sessions: [], messages: [] };
    if (!Array.isArray(this.data.sessions)) this.data.sessions = [];
    if (!Array.isArray(this.data.messages)) this.data.messages = [];
    this.seq = this.data.messages.reduce((max, message) => Math.max(max, Number(message.id) || 0), 0);
  }

  persist() {
    writeJsonAtomic(this.file, this.data, { mode: 0o600 });
  }

  listSessions(limit = 50) {
    return [...this.data.sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((session) => ({
        ...session,
        messageCount: this.data.messages.filter((message) => message.sessionId === session.id).length,
      }));
  }

  getSession(id) {
    const session = this.data.sessions.find((entry) => entry.id === id);
    if (!session) return null;
    const { sessionId, ...rest } = session;
    return rest;
  }

  createSession({ id = newSessionId(), title = 'New Session', model = null, workspace = null, project = null } = {}) {
    const now = Date.now();
    this.data.sessions.push({ id, title: safeText(title, 200), createdAt: now, updatedAt: now, model, workspace, project });
    this.persist();
    return this.getSession(id);
  }

  updateSession(id, patch = {}) {
    const session = this.data.sessions.find((entry) => entry.id === id);
    if (!session) return null;
    if (patch.title !== undefined) session.title = safeText(patch.title, 200);
    if (patch.model !== undefined) session.model = patch.model;
    if (patch.workspace !== undefined) session.workspace = patch.workspace;
    if (patch.project !== undefined) session.project = patch.project;
    if (patch.touch !== false) session.updatedAt = Date.now();
    this.persist();
    return this.getSession(id);
  }

  deleteSession(id) {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((entry) => entry.id !== id);
    this.data.messages = this.data.messages.filter((message) => message.sessionId !== id);
    this.persist();
    return this.data.sessions.length < before;
  }

  appendMessage(sessionId, { role, content = '', toolName = null, meta = null } = {}) {
    this.seq += 1;
    const message = {
      id: this.seq,
      sessionId,
      role,
      content: safeText(content),
      toolName,
      meta: safeMeta(meta),
      createdAt: Date.now(),
    };
    this.data.messages.push(message);
    this.updateSession(sessionId, { touch: true });
    this.persist();
    const { sessionId: _omit, ...rest } = message;
    return { ...rest, id: String(message.id) };
  }

  getMessages(sessionId, { limit = 500 } = {}) {
    return this.data.messages
      .filter((message) => message.sessionId === sessionId)
      .slice(0, limit)
      .map((message) => ({ ...message, id: String(message.id) }));
  }

  replaceMessages(sessionId, messages = []) {
    this.data.messages = this.data.messages.filter((message) => message.sessionId !== sessionId);
    for (const message of messages) this.appendMessage(sessionId, message);
    return this.getMessages(sessionId);
  }

  clearMessages(sessionId) {
    this.data.messages = this.data.messages.filter((message) => message.sessionId !== sessionId);
    this.persist();
  }

  count() {
    return this.data.sessions.length;
  }

  close() {
    this.persist();
  }
}

export function openSessionStore({ file = paths.sessions(), fallbackFile = paths.sessionsFallback(), preferSqlite = true } = {}) {
  if (preferSqlite) {
    try {
      return new SqliteSessionStore(file);
    } catch (error) {
      if (process.env.MIKUHOST_DEBUG) {
        process.stderr.write(`[mikuhost] SQLite unavailable, using JSON store: ${error?.message}\n`);
      }
    }
  }
  return new JsonSessionStore(fallbackFile);
}

