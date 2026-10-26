// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/paths.mjs';
import { readJson, writeJsonAtomic } from '../util/atomic.mjs';

/** Largest file an undo entry can restore; bigger files are simply not snapshotted. */
export const MAX_SNAPSHOT_BYTES = 512 * 1024;
/** How many edits stay undoable. Older snapshots are deleted with their entry. */
export const MAX_ENTRIES = 40;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function isInside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

/**
 * Pre-edit snapshots of files the agent writes.
 *
 * Every entry records what the file looked like BEFORE the tool ran plus a hash
 * of what the tool wrote, so `/undo` can restore the old content and refuse to
 * clobber a file the user changed afterwards. Snapshots live next to the config
 * (0600) and are bounded, so this never grows without limit.
 */
export class FileHistory {
  constructor({
    file = paths.historyIndex(),
    dir = paths.historyDir(),
    maxEntries = MAX_ENTRIES,
    maxSnapshotBytes = MAX_SNAPSHOT_BYTES,
  } = {}) {
    this.file = file;
    this.dir = dir;
    this.maxEntries = maxEntries;
    this.maxSnapshotBytes = maxSnapshotBytes;
    this.entries = this.#read();
  }

  #read() {
    const data = readJson(this.file, null);
    if (!Array.isArray(data?.entries)) return [];
    return data.entries.filter((entry) => entry && entry.id && entry.absolute);
  }

  #persist() {
    writeJsonAtomic(this.file, { version: 1, entries: this.entries }, { mode: 0o600 });
  }

  #snapshotFile(id) {
    return path.join(this.dir, `${id}.snapshot`);
  }

  #prune() {
    while (this.entries.length > this.maxEntries) {
      const dropped = this.entries.shift();
      try {
        fs.unlinkSync(this.#snapshotFile(dropped.id));
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * Remember a file's previous version before it is changed.
   * Returns the entry, or null when the edit cannot be undone safely
   * (binary/unreadable/too large previous content).
   */
  record({ sessionId = null, workspace = null, absolute, relPath = null, tool = 'write', previous = null, next = null } = {}) {
    if (!absolute) return null;
    const existed = typeof previous === 'string';
    const content = existed ? previous : '';
    if (existed && Buffer.byteLength(content, 'utf8') > this.maxSnapshotBytes) return null;

    const id = `h_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const entry = {
      id,
      sessionId: sessionId ?? null,
      workspace: workspace ?? null,
      absolute: path.resolve(absolute),
      relPath,
      tool,
      createdAt: Date.now(),
      existed,
      bytes: existed ? Buffer.byteLength(content, 'utf8') : 0,
      // Hash of the content the tool wrote; undo compares it with the file on
      // disk and refuses when they differ unless forced.
      afterHash: typeof next === 'string' ? sha256(next) : null,
    };

    if (existed) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeJsonAtomic(this.#snapshotFile(id), { content }, { mode: 0o600 });
    }
    this.entries.push(entry);
    this.#prune();
    this.#persist();
    return entry;
  }

  /** Newest first. `sessionId: null` means every session. */
  list({ sessionId = null, limit = 20 } = {}) {
    return this.entries
      .filter((entry) => sessionId === null || entry.sessionId === sessionId)
      .slice()
      .reverse()
      .slice(0, Math.max(1, limit));
  }

  #latestIndex(sessionId = null) {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (sessionId === null || entry.sessionId === sessionId) return index;
    }
    return -1;
  }

  /**
   * Restore the most recent snapshot (of one session, when given).
   * A file the agent created is deleted again, as long as it is unchanged.
   */
  undo({ sessionId = null, force = false } = {}) {
    const index = this.#latestIndex(sessionId);
    if (index === -1) return { ok: false, reason: 'empty' };
    const entry = this.entries[index];

    // Defensive: never write outside the workspace recorded with the entry.
    if (entry.workspace && !isInside(entry.workspace, entry.absolute)) {
      return { ok: false, reason: 'outside-workspace', entry };
    }

    let current = null;
    if (fs.existsSync(entry.absolute)) {
      try {
        current = fs.readFileSync(entry.absolute, 'utf8');
      } catch {
        return { ok: false, reason: 'unreadable', entry };
      }
      if (!force && entry.afterHash && sha256(current) !== entry.afterHash) {
        return { ok: false, reason: 'changed', entry };
      }
    }

    if (entry.existed) {
      let content;
      try {
        const snapshot = readJson(this.#snapshotFile(entry.id), null);
        if (typeof snapshot?.content !== 'string') throw new Error('missing snapshot');
        content = snapshot.content;
      } catch {
        return { ok: false, reason: 'missing-snapshot', entry };
      }
      fs.mkdirSync(path.dirname(entry.absolute), { recursive: true, mode: 0o755 });
      fs.writeFileSync(entry.absolute, content, 'utf8');
    } else if (current !== null) {
      fs.rmSync(entry.absolute);
    }

    this.entries.splice(index, 1);
    try {
      fs.unlinkSync(this.#snapshotFile(entry.id));
    } catch {
      /* ignore */
    }
    this.#persist();
    return { ok: true, entry, removed: !entry.existed };
  }
}
