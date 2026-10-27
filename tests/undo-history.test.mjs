// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FileHistory } from '../src/history/file-history.mjs';
import { ToolRegistry } from '../src/tools/registry.mjs';
import { Workspace } from '../src/security/workspace.mjs';
import { AgentRuntime } from '../src/core/agent.mjs';
import { SessionManager } from '../src/sessions/manager.mjs';
import { openSessionStore } from '../src/sessions/database.mjs';
import { makeConfigStub, workspaceFixture, tempDir, cleanupDir } from './helpers.mjs';

function harness({ root, history, sessionId = 's_test' }) {
  const config = makeConfigStub({ workspace: root });
  const registry = new ToolRegistry({
    workspace: new Workspace(root),
    config,
    history,
    session: { id: sessionId },
    requestApproval: async () => true,
  });
  return registry;
}

function tempHistory(dir) {
  return new FileHistory({ file: path.join(dir, 'index.json'), dir: path.join(dir, 'snapshots') });
}

test('undo: write_file snapshots the old content and /undo restores it', async () => {
  const dir = tempDir('mikuhost-undo-');
  const root = workspaceFixture();
  try {
    const history = tempHistory(dir);
    const registry = harness({ root, history });
    const target = path.join(root, 'project', 'src', 'index.js');
    const original = fs.readFileSync(target, 'utf8');

    const written = await registry.execute('write_file', {
      path: 'project/src/index.js',
      content: 'export const x = 1;\n',
    });
    assert.equal(written.ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'export const x = 1;\n');

    const listed = history.list({ sessionId: 's_test' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].tool, 'write_file');
    assert.equal(listed[0].existed, true);
    assert.equal(listed[0].relPath, 'project/src/index.js');

    const undone = history.undo({ sessionId: 's_test' });
    assert.equal(undone.ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), original, 'the previous version comes back');
    assert.deepEqual(history.list({ sessionId: 's_test' }), []);
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('undo: edit_file and create_file are both undoable', async () => {
  const dir = tempDir('mikuhost-undo-edit-');
  const root = workspaceFixture();
  try {
    const history = tempHistory(dir);
    const registry = harness({ root, history });
    const target = path.join(root, 'project', 'src', 'index.js');
    const original = fs.readFileSync(target, 'utf8');

    const edited = await registry.execute('edit_file', {
      path: 'project/src/index.js',
      old_string: "require('express')",
      new_string: "require('fastify')",
    });
    assert.equal(edited.ok, true);
    assert.match(fs.readFileSync(target, 'utf8'), /fastify/);

    assert.equal(history.undo({ sessionId: 's_test' }).ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), original);

    const createdPath = path.join(root, 'project', 'src', 'new.js');
    const created = await registry.execute('create_file', {
      path: 'project/src/new.js',
      content: 'export const created = true;\n',
    });
    assert.equal(created.ok, true);
    assert.equal(fs.existsSync(createdPath), true);

    const undone = history.undo({ sessionId: 's_test' });
    assert.equal(undone.ok, true);
    assert.equal(undone.removed, true);
    assert.equal(fs.existsSync(createdPath), false, 'a file the agent created is removed again');
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('undo: a file changed afterwards is not clobbered unless forced', async () => {
  const dir = tempDir('mikuhost-undo-changed-');
  const root = workspaceFixture();
  try {
    const history = tempHistory(dir);
    const registry = harness({ root, history });
    const target = path.join(root, 'project', 'src', 'index.js');
    const original = fs.readFileSync(target, 'utf8');

    await registry.execute('write_file', { path: 'project/src/index.js', content: 'agent version\n' });
    fs.writeFileSync(target, 'my own edit\n', 'utf8');

    const refused = history.undo({ sessionId: 's_test' });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'changed');
    assert.equal(fs.readFileSync(target, 'utf8'), 'my own edit\n');

    const forced = history.undo({ sessionId: 's_test', force: true });
    assert.equal(forced.ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('undo: entries are per session and bounded', async () => {
  const dir = tempDir('mikuhost-undo-scope-');
  const root = workspaceFixture();
  try {
    const history = tempHistory(dir);
    const fileA = path.join(root, 'project', 'src', 'a.js');
    const fileB = path.join(root, 'project', 'src', 'b.js');
    fs.writeFileSync(fileA, 'a-new');
    fs.writeFileSync(fileB, 'b-new');

    history.record({ sessionId: 's_one', workspace: root, absolute: fileA, relPath: 'project/src/a.js', tool: 'write_file', previous: 'a-old', next: 'a-new' });
    history.record({ sessionId: 's_two', workspace: root, absolute: fileB, relPath: 'project/src/b.js', tool: 'write_file', previous: 'b-old', next: 'b-new' });

    assert.equal(history.list({ sessionId: 's_one' }).length, 1);
    const undone = history.undo({ sessionId: 's_one' });
    assert.equal(undone.ok, true);
    assert.equal(fs.readFileSync(fileA, 'utf8'), 'a-old');
    assert.equal(fs.readFileSync(fileB, 'utf8'), 'b-new', 'another session is untouched');
    assert.equal(history.list({ sessionId: 's_two' }).length, 1);

    // Bounded store: only the newest N entries survive, older snapshots go away.
    const boundedDir = tempDir('mikuhost-undo-bound-');
    try {
      const bounded = new FileHistory({
        file: path.join(boundedDir, 'index.json'),
        dir: path.join(boundedDir, 'snapshots'),
        maxEntries: 2,
      });
      for (let index = 0; index < 4; index += 1) {
        bounded.record({ sessionId: 's', workspace: root, absolute: fileA, previous: `old-${index}`, next: null });
      }
      assert.equal(bounded.list({ sessionId: 's' }).length, 2);
      assert.equal(fs.readdirSync(path.join(boundedDir, 'snapshots')).length, 2);
    } finally {
      cleanupDir(boundedDir);
    }
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('undo: a real agent turn records the write and leaves it undoable', async () => {
  const dir = tempDir('mikuhost-undo-runtime-');
  const root = workspaceFixture();
  try {
    const config = makeConfigStub({ workspace: root, permissions: { fileWrite: 'auto' } });
    const workspace = new Workspace(root);
    const store = openSessionStore({ file: path.join(dir, 'sessions.db') });
    const session = new SessionManager({ store, config, workspace: root });
    session.create({ model: 'z-ai/glm-5.3-flash', workspace: root });
    const history = tempHistory(dir);
    const target = path.join(root, 'project', 'src', 'index.js');
    const original = fs.readFileSync(target, 'utf8');

    const turns = [
      [
        {
          type: 'done',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'project/src/index.js', content: 'agent wrote this\n' }) } },
          ],
        },
      ],
      [{ type: 'text', text: 'Written.' }, { type: 'done', finishReason: 'stop' }],
    ];
    let call = 0;
    const provider = {
      async *streamChat() {
        const turn = turns[Math.min(call, turns.length - 1)];
        call += 1;
        for (const event of turn) yield event;
      },
    };
    const credentials = {
      activeEntry: () => ({ id: 'k', name: 'Test', key: 'nvapi-test' }),
      touch: () => {},
      reportFailure: () => {},
    };
    const runtime = new AgentRuntime({ config, workspace, credentials, session, providerFactory: () => provider, history });
    const result = await runtime.send('tulis file');
    assert.equal(result.error, null);
    assert.equal(fs.readFileSync(target, 'utf8'), 'agent wrote this\n');

    const entries = runtime.history.list({ sessionId: session.id });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tool, 'write_file');
    assert.equal(entries[0].relPath, 'project/src/index.js');

    const undone = runtime.history.undo({ sessionId: session.id });
    assert.equal(undone.ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    store.close();
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('undo turn: every file the turn changed is reverted at once', async () => {
  const dir = tempDir('mikuhost-undo-turn-');
  const root = workspaceFixture();
  try {
    const history = tempHistory(dir);
    const fileA = path.join(root, 'project', 'src', 'a.js');
    const fileB = path.join(root, 'project', 'src', 'b.js');
    fs.writeFileSync(fileA, 'a-after');
    fs.writeFileSync(fileB, 'b-after');

    history.record({ sessionId: 's', workspace: root, absolute: fileA, relPath: 'project/src/a.js', tool: 'write_file', previous: 'a-before', next: 'a-after', turnId: 't1' });
    history.record({ sessionId: 's', workspace: root, absolute: fileB, relPath: 'project/src/b.js', tool: 'edit_file', previous: 'b-before', next: 'b-after', turnId: 't1' });

    assert.equal(history.latestTurn({ sessionId: 's' }), 't1');
    const result = history.undoTurn({ sessionId: 's' });
    assert.equal(result.ok, true);
    assert.equal(result.restored.length, 2);
    assert.deepEqual(result.skipped, []);
    assert.equal(fs.readFileSync(fileA, 'utf8'), 'a-before');
    assert.equal(fs.readFileSync(fileB, 'utf8'), 'b-before');
    assert.deepEqual(history.list({ sessionId: 's' }), []);
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('undo turn: only the newest turn is reverted, earlier turns stay undoable', async () => {
  const dir = tempDir('mikuhost-undo-turn-scope-');
  const root = workspaceFixture();
  try {
    const history = tempHistory(dir);
    const fileA = path.join(root, 'project', 'src', 'a.js');
    const fileB = path.join(root, 'project', 'src', 'b.js');
    fs.writeFileSync(fileA, 'a-t1');
    fs.writeFileSync(fileB, 'b-t2');

    history.record({ sessionId: 's', workspace: root, absolute: fileA, relPath: 'project/src/a.js', tool: 'write_file', previous: 'a-original', next: 'a-t1', turnId: 't1' });
    history.record({ sessionId: 's', workspace: root, absolute: fileB, relPath: 'project/src/b.js', tool: 'write_file', previous: 'b-original', next: 'b-t2', turnId: 't2' });

    const result = history.undoTurn({ sessionId: 's' });
    assert.equal(result.ok, true);
    assert.equal(result.turnId, 't2');
    assert.equal(fs.readFileSync(fileB, 'utf8'), 'b-original');
    assert.equal(fs.readFileSync(fileA, 'utf8'), 'a-t1', 'the earlier turn is untouched');

    // The earlier turn is still on the stack, and now the newest one.
    assert.equal(history.latestTurn({ sessionId: 's' }), 't1');
    assert.equal(history.undoTurn({ sessionId: 's' }).ok, true);
    assert.equal(fs.readFileSync(fileA, 'utf8'), 'a-original');
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('undo turn: repeated edits to one file unwind newest first', async () => {
  const dir = tempDir('mikuhost-undo-turn-order-');
  const root = workspaceFixture();
  try {
    const history = tempHistory(dir);
    const target = path.join(root, 'project', 'src', 'index.js');
    fs.writeFileSync(target, 'v2');

    history.record({ sessionId: 's', workspace: root, absolute: target, relPath: 'project/src/index.js', tool: 'write_file', previous: 'v0', next: 'v1', turnId: 't1' });
    history.record({ sessionId: 's', workspace: root, absolute: target, relPath: 'project/src/index.js', tool: 'edit_file', previous: 'v1', next: 'v2', turnId: 't1' });

    const result = history.undoTurn({ sessionId: 's' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.skipped, []);
    // The second edit is undone against its own "after" hash, which is only
    // true once the first one has been put back.
    assert.equal(fs.readFileSync(target, 'utf8'), 'v0');
    assert.deepEqual(history.list({ sessionId: 's' }), []);
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('undo turn: a file changed by the user is skipped, the rest still reverts', async () => {
  const dir = tempDir('mikuhost-undo-turn-changed-');
  const root = workspaceFixture();
  try {
    const history = tempHistory(dir);
    const mine = path.join(root, 'project', 'src', 'a.js');
    const theirs = path.join(root, 'project', 'src', 'b.js');
    fs.writeFileSync(mine, 'agent wrote this');
    fs.writeFileSync(theirs, 'b-after');

    history.record({ sessionId: 's', workspace: root, absolute: mine, relPath: 'project/src/a.js', tool: 'write_file', previous: 'a-before', next: 'agent wrote this', turnId: 't1' });
    history.record({ sessionId: 's', workspace: root, absolute: theirs, relPath: 'project/src/b.js', tool: 'write_file', previous: 'b-before', next: 'b-after', turnId: 't1' });

    fs.writeFileSync(mine, 'my own edit');

    const result = history.undoTurn({ sessionId: 's' });
    assert.equal(result.ok, true, 'the rest of the turn is still reverted');
    assert.equal(fs.readFileSync(mine, 'utf8'), 'my own edit', 'my own edit survives');
    assert.equal(fs.readFileSync(theirs, 'utf8'), 'b-before');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'changed');
    assert.equal(result.skipped[0].entry.relPath, 'project/src/a.js');
    assert.equal(history.list({ sessionId: 's' }).length, 1, 'the skipped entry stays undoable');

    const forced = history.undoTurn({ sessionId: 's', force: true });
    assert.equal(forced.ok, true);
    assert.equal(fs.readFileSync(mine, 'utf8'), 'a-before');
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('undo turn: a file the turn created is removed again', async () => {
  const dir = tempDir('mikuhost-undo-turn-create-');
  const root = workspaceFixture();
  try {
    const history = tempHistory(dir);
    const created = path.join(root, 'project', 'src', 'fresh.js');
    fs.writeFileSync(created, 'brand new');

    history.record({ sessionId: 's', workspace: root, absolute: created, relPath: 'project/src/fresh.js', tool: 'create_file', previous: null, next: 'brand new', turnId: 't1' });

    const result = history.undoTurn({ sessionId: 's' });
    assert.equal(result.ok, true);
    assert.equal(result.removed.length, 1);
    assert.equal(result.restored.length, 0);
    assert.equal(fs.existsSync(created), false);
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('undo turn: snapshots without a turn id are never grouped together', async () => {
  const dir = tempDir('mikuhost-undo-turn-legacy-');
  const root = workspaceFixture();
  try {
    const history = tempHistory(dir);
    const fileA = path.join(root, 'project', 'src', 'a.js');
    const fileB = path.join(root, 'project', 'src', 'b.js');
    fs.writeFileSync(fileA, 'a-after');
    fs.writeFileSync(fileB, 'b-after');

    // Entries written by an older version have no turn id at all.
    history.record({ sessionId: 's', workspace: root, absolute: fileA, relPath: 'project/src/a.js', tool: 'write_file', previous: 'a-before', next: 'a-after' });
    history.record({ sessionId: 's', workspace: root, absolute: fileB, relPath: 'project/src/b.js', tool: 'write_file', previous: 'b-before', next: 'b-after' });

    assert.equal(history.latestTurn({ sessionId: 's' }), null);
    const result = history.undoTurn({ sessionId: 's' });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(fileB, 'utf8'), 'b-before', 'the newest entry is reverted');
    assert.equal(fs.readFileSync(fileA, 'utf8'), 'a-after', 'an unrelated older entry is not swept up');
    assert.equal(history.list({ sessionId: 's' }).length, 1);
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('undo turn: one agent turn groups every write it made', async () => {
  const dir = tempDir('mikuhost-undo-turn-runtime-');
  const root = workspaceFixture();
  try {
    const config = makeConfigStub({ workspace: root, permissions: { fileWrite: 'auto' } });
    const workspace = new Workspace(root);
    const store = openSessionStore({ file: path.join(dir, 'sessions.db') });
    const session = new SessionManager({ store, config, workspace: root });
    session.create({ model: 'z-ai/glm-5.3-flash', workspace: root });
    const history = tempHistory(dir);
    const edited = path.join(root, 'project', 'src', 'index.js');
    const created = path.join(root, 'project', 'src', 'created.js');
    const original = fs.readFileSync(edited, 'utf8');

    const turns = [
      [
        {
          type: 'done',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'project/src/index.js', content: 'first\n' }) } },
            { id: 'c2', type: 'function', function: { name: 'create_file', arguments: JSON.stringify({ path: 'project/src/created.js', content: 'second\n' }) } },
          ],
        },
      ],
      [{ type: 'text', text: 'Both written.' }, { type: 'done', finishReason: 'stop' }],
    ];
    let call = 0;
    const provider = {
      async *streamChat() {
        const turn = turns[Math.min(call, turns.length - 1)];
        call += 1;
        for (const event of turn) yield event;
      },
    };
    const credentials = {
      activeEntry: () => ({ id: 'k', name: 'Test', key: 'nvapi-test' }),
      touch: () => {},
      reportFailure: () => {},
    };
    const runtime = new AgentRuntime({ config, workspace, credentials, session, providerFactory: () => provider, history });
    const result = await runtime.send('tulis dua file');
    assert.equal(result.error, null);

    const entries = history.list({ sessionId: session.id });
    assert.equal(entries.length, 2);
    assert.ok(entries[0].turnId, 'the turn id is recorded on every snapshot');
    assert.equal(new Set(entries.map((entry) => entry.turnId)).size, 1, 'both writes share one turn id');

    const undone = history.undoTurn({ sessionId: session.id });
    assert.equal(undone.ok, true);
    assert.equal(undone.restored.length, 1);
    assert.equal(undone.removed.length, 1);
    assert.equal(fs.readFileSync(edited, 'utf8'), original);
    assert.equal(fs.existsSync(created), false);

    // A later turn gets its own id instead of joining the previous one.
    call = 0;
    await runtime.send('tulis lagi');
    const next = history.list({ sessionId: session.id });
    assert.equal(next.length, 2);
    assert.notEqual(next[0].turnId, undone.turnId);
    store.close();
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});
