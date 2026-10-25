import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openSessionStore, newSessionId } from '../src/sessions/database.mjs';
import { SessionManager } from '../src/sessions/manager.mjs';
import { tempDir, cleanupDir } from './helpers.mjs';

const SECRET = 'nvapi-shouldberedacted0123456789';

function stores(dir) {
  return [
    { name: 'sqlite', store: openSessionStore({ file: path.join(dir, 'sessions.db'), preferSqlite: true }) },
    { name: 'json', store: openSessionStore({ file: path.join(dir, 'unused.db'), fallbackFile: path.join(dir, 'sessions.json'), preferSqlite: false }) },
  ];
}

test('sessions: create, append, list, rename and delete', () => {
  const dir = tempDir('mikuhost-sessions-');
  try {
    for (const { name, store } of stores(dir)) {
      const session = store.createSession({ title: 'Fix bot', model: 'z-ai/glm-5.3-flash', workspace: '/root' });
      assert.ok(session.id.startsWith('s_'), name);
      assert.equal(session.title, 'Fix bot');
      assert.equal(store.getSession(session.id).model, 'z-ai/glm-5.3-flash');

      store.appendMessage(session.id, { role: 'user', content: 'hello' });
      store.appendMessage(session.id, {
        role: 'assistant',
        content: 'checking',
        meta: { toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      });
      store.appendMessage(session.id, { role: 'tool', toolName: 'read_file', content: '{}', meta: { ok: true, toolCallId: 'c1' } });

      const messages = store.getMessages(session.id);
      assert.equal(messages.length, 3);
      assert.equal(messages[2].role, 'tool');
      assert.equal(messages[2].meta.toolCallId, 'c1');
      assert.equal(messages[2].toolName, 'read_file');

      const listed = store.listSessions();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].messageCount, 3);

      store.updateSession(session.id, { title: 'Renamed' });
      assert.equal(store.getSession(session.id).title, 'Renamed');

      store.clearMessages(session.id);
      assert.equal(store.getMessages(session.id).length, 0);

      assert.equal(store.deleteSession(session.id), true);
      assert.equal(store.getSession(session.id), null);
      assert.equal(store.deleteSession(session.id), false);
      store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('sessions: secrets and credential metadata are redacted before storage', () => {
  const dir = tempDir('mikuhost-redact-');
  try {
    for (const { name, store } of stores(dir)) {
      const session = store.createSession({ title: 'Secrets' });
      store.appendMessage(session.id, {
        role: 'user',
        content: `here is my key ${SECRET} and password=hunter2hunter2`,
      });
      store.appendMessage(session.id, {
        role: 'tool',
        toolName: 'read_file',
        content: `output ${SECRET}`,
        meta: { ok: true, apiKey: SECRET, token: SECRET, path: 'src/app.js' },
      });
      const messages = store.getMessages(session.id);
      assert.equal(messages[0].content.includes(SECRET), false, name);
      assert.equal(messages[1].content.includes(SECRET), false, name);
      assert.equal(JSON.stringify(messages[1].meta).includes(SECRET), false, name);
      assert.equal(messages[1].meta.path, 'src/app.js');
      store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('sessions: sqlite persists across reopen', () => {
  const dir = tempDir('mikuhost-reopen-');
  try {
    const file = path.join(dir, 'sessions.db');
    const first = openSessionStore({ file });
    const session = first.createSession({ title: 'Persisted' });
    first.appendMessage(session.id, { role: 'user', content: 'remember me' });
    first.close();

    const second = openSessionStore({ file });
    const reloaded = second.getSession(session.id);
    assert.equal(reloaded.title, 'Persisted');
    assert.equal(second.getMessages(session.id)[0].content, 'remember me');
    assert.ok(second.count() >= 1);
    second.close();
  } finally {
    cleanupDir(dir);
  }
});

test('session manager: auto titles, model, restore and delete', () => {
  const dir = tempDir('mikuhost-manager-');
  try {
    let lastSessionId = null;
    const config = {
      get: () => ({ lastSessionId }),
      setValue: (key, value) => {
        if (key === 'lastSessionId') lastSessionId = value;
      },
    };
    const store = openSessionStore({ file: path.join(dir, 'sessions.db') });
    const manager = new SessionManager({ store, config, model: 'z-ai/glm-5.3-flash', workspace: '/root' });

    const session = manager.create({});
    assert.equal(session.title, 'New Session');
    manager.appendMessage({ role: 'user', content: 'Cek kenapa bot Baileys gue disconnect' });
    assert.equal(manager.title, 'Cek kenapa bot Baileys gue disconnect');
    manager.appendMessage({ role: 'assistant', content: 'Kemungkinan reconnect handler.' });
    assert.equal(manager.messages.length, 2);

    manager.setModel('poolside/laguna-xs-2.1');
    assert.equal(manager.session.model, 'poolside/laguna-xs-2.1');

    manager.rename('Baileys debug');
    assert.equal(manager.title, 'Baileys debug');

    const restored = new SessionManager({ store, config });
    // Simulate a fresh process: store's own list is authoritative.
    const opened = restored.restoreLast();
    assert.ok(opened);
    assert.equal(opened.title, 'Baileys debug');
    assert.equal(restored.messages.length, 2);

    restored.clearMessages();
    assert.equal(restored.messages.length, 0);
    assert.equal(restored.delete(), true);
    assert.equal(restored.session, null);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test('session ids are unique', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
  assert.equal(ids.size, 50);
});
