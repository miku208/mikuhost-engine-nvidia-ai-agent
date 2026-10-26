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
