// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { NvidiaProvider } from '../src/providers/nvidia.mjs';
import { runAgentLoop } from '../src/core/agent-loop.mjs';
import { AgentRuntime } from '../src/core/agent.mjs';
import { EVENTS, PHASES } from '../src/core/events.mjs';
import { buildChatLines } from '../src/ui/text-layout.mjs';
import { attachmentWindow } from '../src/ui/composer-layout.mjs';
import {
  cycleSelection,
  escapeAction,
  lineAtRow,
  removeAttachmentById,
} from '../src/ui/selection.mjs';
import { applyTextInput } from '../src/ui/input-edit.mjs';
import { describeKeyEvent } from '../src/ui/keyboard-inspector.mjs';
import {
  REASONING_DEFAULTS,
  extractReasoning,
  reasoningFromEvent,
  reasoningSettings,
} from '../src/reasoning/parser.mjs';
import { mergeWithDefaults } from '../src/config/manager.mjs';
import { SLASH_COMMANDS } from '../src/ui/slash.mjs';
import {
  PASTE_CONTEXT_LIMIT,
  createPasteBatcher,
  createPastedAttachment,
  pasteSettings,
} from '../src/paste/attachments.mjs';
import { SessionManager } from '../src/sessions/manager.mjs';
import { openSessionStore } from '../src/sessions/database.mjs';
import { Workspace } from '../src/security/workspace.mjs';
import {
  makeConfigStub,
  workspaceFixture,
  tempDir,
  cleanupDir,
  setConfigDir,
  startMockServer,
  sendJson,
  sendSse,
} from './helpers.mjs';

const MODEL = 'nvidia/nemotron-3-nano-30b-a3b';
const KEY = 'nvapi-reasoning-test-1234567890';

async function withServer(handler, run) {
  const server = await startMockServer(handler);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

function scriptedProvider(turns) {
  const calls = [];
  return {
    calls,
    async *streamChat(options) {
      calls.push({ ...options, messages: options.messages.map((message) => ({ ...message })) });
      const turn = turns[Math.min(calls.length - 1, turns.length - 1)];
      for (const event of turn) yield event;
    },
  };
}

const key = (overrides = {}) => ({
  ctrl: false,
  meta: false,
  shift: false,
  leftArrow: false,
  rightArrow: false,
  upArrow: false,
  downArrow: false,
  return: false,
  escape: false,
  tab: false,
  backspace: false,
  delete: false,
  home: false,
  end: false,
  ...overrides,
});

test('reasoning: parser reads explicit fields only and never guesses', () => {
  assert.equal(extractReasoning({ reasoning_content: 'thinking' }), 'thinking');
  assert.equal(extractReasoning({ reasoning: 'chain' }), 'chain');
  assert.equal(extractReasoning({ reasoning: { text: 'object chain' } }), 'object chain');
  assert.equal(extractReasoning({ reasoning: { summary: [{ text: 'nested summary' }] } }), 'nested summary');
  assert.equal(extractReasoning({ thinking: { thinking: 'thinking object' } }), 'thinking object');
  assert.equal(
    extractReasoning({
      reasoning_details: [
        { type: 'reasoning.text', text: 'first ' },
        { type: 'reasoning.summary', summary: 'second' },
      ],
    }),
    'first second',
  );
  assert.equal(extractReasoning({ content: 'just an answer' }), '');
  assert.equal(extractReasoning({ reasoning_content: '' }), '');
  assert.equal(extractReasoning({ reasoning_content: 42 }), '');
  assert.equal(extractReasoning(null), '');
  assert.equal(reasoningFromEvent({ choices: [{ delta: { content: 'answer only' } }] }), '');
  assert.equal(
    reasoningFromEvent({ choices: [{ delta: { reasoning_content: 'choice chain', content: 'answer' } }] }),
    'choice chain',
  );
  assert.equal(reasoningFromEvent({ type: 'reasoning', delta: { text: 'event chain' } }), 'event chain');
});

test('reasoning: config defaults, validation and slash command', () => {
  assert.deepEqual(reasoningSettings({}), {
    mode: 'auto',
    enabled: true,
    autoCollapseAfterComplete: true,
    showElapsedTime: true,
  });
  assert.equal(reasoningSettings({ mode: 'off' }).enabled, false);
  assert.equal(reasoningSettings({ mode: 'nope' }).mode, 'auto');
  assert.equal(reasoningSettings({ mode: 'on', autoCollapseAfterComplete: false }).autoCollapseAfterComplete, false);

  const merged = mergeWithDefaults({ ui: { reasoning: { mode: 'nope', showElapsedTime: false } } });
  assert.equal(merged.ui.reasoning.mode, REASONING_DEFAULTS.mode);
  assert.equal(merged.ui.reasoning.showElapsedTime, false);
  assert.deepEqual(mergeWithDefaults({}).providers.nvidia.reasoningParams, {});
  assert.deepEqual(mergeWithDefaults({ providers: { nvidia: { reasoningParams: null } } }).providers.nvidia.reasoningParams, {});
  assert.ok(SLASH_COMMANDS.some((command) => command.name === 'reasoning'));

  // Pasted-text context limit: 60k default and hard maximum.
  assert.equal(PASTE_CONTEXT_LIMIT, 60_000);
  assert.equal(pasteSettings({ maxContextCharacters: 120_000 }).maxContextCharacters, 60_000);
  assert.equal(pasteSettings({ maxContextCharacters: 5_000 }).maxContextCharacters, 5_000);
  assert.equal(mergeWithDefaults({}).ui.paste.maxContextCharacters, 60_000);
  assert.equal(
    mergeWithDefaults({ ui: { paste: { maxContextCharacters: 100_000 } } }).ui.paste.maxContextCharacters,
    60_000,
  );
});

test('provider: streams reasoning_content separately from the final answer', async () => {
  await withServer(
    (req, res) => {
      sendSse(res, [
        { choices: [{ index: 0, delta: { reasoning_content: 'Analyzing ' } }] },
        { choices: [{ index: 0, delta: { reasoning_content: 'the project.' } }] },
        { choices: [{ index: 0, delta: { content: 'The answer ' } }] },
        { choices: [{ index: 0, delta: { content: 'is 42.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]);
    },
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      const events = [];
      for await (const event of provider.streamChat({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] })) {
        events.push(event);
      }
      assert.equal(
        events.filter((event) => event.type === 'reasoning').map((event) => event.text).join(''),
        'Analyzing the project.',
      );
      assert.equal(
        events.filter((event) => event.type === 'text').map((event) => event.text).join(''),
        'The answer is 42.',
      );
      const reasoningIndex = events.findIndex((event) => event.type === 'reasoning');
      const answerIndex = events.findIndex((event) => event.type === 'text');
      assert.ok(reasoningIndex < answerIndex, 'reasoning chunks must come before answer chunks');
      assert.equal(events.some((event) => event.type === 'reasoning' && /answer/i.test(event.text)), false);

      const result = await provider.chat({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(result.text, 'The answer is 42.');
      assert.equal(result.text.includes('Analyzing'), false);
    },
  );
});

test('provider: supports reasoning and reasoning_details fields, ignores empty chunks', async () => {
  await withServer(
    (req, res) => {
      sendSse(res, [
        { choices: [{ index: 0, delta: { reasoning: 'via reasoning ' } }] },
        { choices: [{ index: 0, delta: { reasoning: '' } }] },
        { choices: [{ index: 0, delta: { reasoning_details: [{ type: 'reasoning.text', text: 'via details.' }] } }] },
        { choices: [{ index: 0, delta: { content: 'Answer.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]);
    },
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      const events = [];
      for await (const event of provider.streamChat({ model: MODEL, messages: [] })) events.push(event);
      assert.equal(
        events.filter((event) => event.type === 'reasoning').map((event) => event.text).join(''),
        'via reasoning via details.',
      );
      assert.equal(events.filter((event) => event.type === 'text').map((event) => event.text).join(''), 'Answer.');
    },
  );
});

test('provider: no reasoning field means no reasoning events', async () => {
  await withServer(
    (req, res) => {
      sendSse(res, [
        { choices: [{ index: 0, delta: { content: 'plain answer' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]);
    },
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      const events = [];
      for await (const event of provider.streamChat({ model: MODEL, messages: [] })) events.push(event);
      assert.equal(events.some((event) => event.type === 'reasoning'), false);
      assert.equal(events.filter((event) => event.type === 'text').map((event) => event.text).join(''), 'plain answer');
    },
  );
});

test('provider: non-streaming fallback still carries real reasoning', async () => {
  await withServer(
    (req, res, { json }) => {
      if (json?.stream) {
        sendJson(res, 400, { error: { message: 'stream is not supported for this model' } });
        return;
      }
      sendJson(res, 200, {
        choices: [
          {
            message: { reasoning_content: 'one-piece chain', content: 'one-piece answer' },
            finish_reason: 'stop',
          },
        ],
      });
    },
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      const events = [];
      for await (const event of provider.streamChat({ model: MODEL, messages: [] })) events.push(event);
      assert.equal(events.find((event) => event.type === 'reasoning').text, 'one-piece chain');
      assert.equal(events.find((event) => event.type === 'text').text, 'one-piece answer');
      assert.equal(events.find((event) => event.type === 'transport').streaming, false);
    },
  );
});

test('provider: per-model request parameters are opt-in and cannot override reserved fields', async () => {
  await withServer(
    (req, res) => {
      sendSse(res, [{ choices: [{ index: 0, delta: { content: 'ok' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]);
    },
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      await provider.chat({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        extraBody: { max_thinking_tokens: 2048, model: 'must-not-override', stream: false, temperature: 0.1 },
      });
      const body = server.requests[0].json;
      assert.equal(body.max_thinking_tokens, 2048);
      assert.equal(body.temperature, 0.1);
      assert.equal(body.model, MODEL);
      assert.equal(body.stream, true);
      assert.equal(body.messages.length, 1);
    },
  );
});

test('agent loop: reasoning and answer events stay ordered and separate', async () => {
  const provider = scriptedProvider([
    [
      { type: 'reasoning', text: 'Step one. ' },
      { type: 'reasoning', text: 'Step two.' },
      { type: 'text', text: 'The final ' },
      { type: 'text', text: 'answer.' },
      { type: 'done', finishReason: 'stop' },
    ],
  ]);
  const events = [];
  const result = await runAgentLoop({
    provider,
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.text, 'The final answer.');
  assert.equal(result.text.includes('Step one'), false);
  assert.equal(result.reasoning, 'Step one. Step two.');
  const types = events.map((event) => event.type);
  const at = (type) => types.indexOf(type);
  assert.ok(at(EVENTS.REASONING_START) >= 0);
  assert.equal(types.filter((type) => type === EVENTS.REASONING_CHUNK).length, 2);
  assert.ok(at(EVENTS.REASONING_START) < at(EVENTS.REASONING_CHUNK));
  assert.ok(at(EVENTS.REASONING_CHUNK) < at(EVENTS.REASONING_COMPLETE));
  assert.ok(at(EVENTS.REASONING_COMPLETE) < at(EVENTS.ANSWER_START));
  assert.ok(at(EVENTS.ANSWER_START) < at(EVENTS.ANSWER_CHUNK));
  assert.ok(at(EVENTS.ANSWER_CHUNK) < at(EVENTS.ANSWER_COMPLETE));
  assert.equal(
    events.filter((event) => event.type === EVENTS.REASONING_CHUNK).map((event) => event.text).join(''),
    'Step one. Step two.',
  );
  const answerEvents = events.filter((event) => event.type === EVENTS.TEXT);
  assert.equal(answerEvents.map((event) => event.text).join(''), 'The final answer.');
  assert.match(result.appended[0].meta.reasoning, /Step two/);
  assert.equal(Number.isFinite(result.appended[0].meta.reasoningMs), true);
  assert.equal(events.at(-1).type, 'done');
});

test('agent loop: interleaved reasoning never contaminates the answer stream', async () => {
  const provider = scriptedProvider([
    [
      { type: 'reasoning', text: 'before ' },
      { type: 'text', text: 'answer one ' },
      { type: 'reasoning', text: 'after ' },
      { type: 'text', text: 'answer two' },
      { type: 'done', finishReason: 'stop' },
    ],
  ]);
  const events = [];
  const result = await runAgentLoop({
    provider,
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.text, 'answer one answer two');
  assert.equal(result.reasoning, 'before after ');
  const sequence = events
    .filter((event) => event.type === 'text' || event.type === 'reasoning:chunk')
    .map((event) => `${event.type}:${event.text}`)
    .join('|');
  assert.equal(
    sequence,
    'reasoning:chunk:before |text:answer one |reasoning:chunk:after |text:answer two',
  );
});

test('agent loop: /reasoning off captures nothing but still streams the answer', async () => {
  const provider = scriptedProvider([
    [
      { type: 'reasoning', text: 'should be ignored' },
      { type: 'text', text: 'answer still here' },
      { type: 'done', finishReason: 'stop' },
    ],
  ]);
  const events = [];
  const result = await runAgentLoop({
    provider,
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    captureReasoning: false,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.text, 'answer still here');
  assert.equal(result.reasoning, '');
  assert.equal(events.some((event) => String(event.type).startsWith('reasoning')), false);
  assert.equal(result.appended[0].meta.reasoning, undefined);
});

test('agent loop: tool iterations carry reasoning into the final answer only once', async () => {
  const provider = scriptedProvider([
    [
      { type: 'reasoning', text: 'I should read the file.' },
      { type: 'done', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
    ],
    [
      { type: 'reasoning', text: 'Now I can answer.' },
      { type: 'text', text: 'Final answer.' },
      { type: 'done', finishReason: 'stop' },
    ],
  ]);
  const result = await runAgentLoop({
    provider,
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    executeTool: async () => ({ ok: true, output: 'contents' }),
  });
  const final = result.appended.find((record) => record.role === 'assistant' && record.content === 'Final answer.');
  assert.match(final.meta.reasoning, /I should read the file\./);
  assert.match(final.meta.reasoning, /Now I can answer\./);
  assert.equal(result.appended[0].meta.reasoning, 'I should read the file.');
  assert.equal(result.text, 'Final answer.');
});

test('layout: live reasoning renders above the answer with a divider', () => {
  const lines = buildChatLines({
    width: 80,
    messages: [],
    draft: { content: 'Final answer streams here.' },
    reasoning: { text: 'Analyzing the project structure...\nChecking files...', active: true, expanded: true, ms: 0 },
    elapsedMs: 8400,
  });
  const text = lines.map((line) => line.text).join('\n');
  assert.match(text, /MIKUHOST ENGINE · 8\.4s/);
  assert.match(text, /▼ Reasoning \(live\)/);
  assert.match(text, /Analyzing the project structure/);
  assert.match(text, /Checking files/);
  assert.match(text, /─{10,}/);
  assert.match(text, /MikuHost:/);
  assert.match(text, /Final answer streams here/);
  assert.ok(lines.findIndex((line) => /Reasoning \(live\)/.test(line.text)) < lines.findIndex((line) => /MikuHost:/.test(line.text)));
  assert.equal(lines.find((line) => /Reasoning \(live\)/.test(line.text)).reasoningFor, 'live');
});

test('layout: reasoning collapses after completion and expands on demand', () => {
  const collapsed = buildChatLines({
    width: 80,
    messages: [],
    reasoning: { text: 'hidden chain', active: false, expanded: false, ms: 12_800 },
  });
  const collapsedText = collapsed.map((line) => line.text).join('\n');
  assert.match(collapsedText, /▶ Thought for 12\.8s/);
  assert.equal(collapsedText.includes('hidden chain'), false);

  const expanded = buildChatLines({
    width: 80,
    messages: [],
    reasoning: { text: 'visible chain', active: false, expanded: true, ms: 12_800 },
  });
  const expandedText = expanded.map((line) => line.text).join('\n');
  assert.match(expandedText, /▼ Thought for 12\.8s/);
  assert.match(expandedText, /visible chain/);

  const noTimer = buildChatLines({
    width: 80,
    messages: [],
    reasoning: { text: 'x', active: false, expanded: false, ms: 12_800, showElapsedTime: false },
  });
  assert.match(noTimer.map((line) => line.text).join('\n'), /▶ Thought$/m);
});

test('layout: persisted reasoning survives reopen and can be expanded', () => {
  const message = {
    id: 'm1',
    role: 'assistant',
    content: 'Saved answer.',
    meta: { reasoning: 'Saved reasoning body.', reasoningMs: 4200, durationMs: 6000 },
  };
  const collapsed = buildChatLines({ width: 80, messages: [message] });
  const collapsedText = collapsed.map((line) => line.text).join('\n');
  assert.match(collapsedText, /▶ Thought for 4\.2s/);
  assert.equal(collapsedText.includes('Saved reasoning body.'), false);

  const expanded = buildChatLines({ width: 80, messages: [message], expandedReasoning: ['m1'] });
  const expandedText = expanded.map((line) => line.text).join('\n');
  assert.match(expandedText, /▼ Thought for 4\.2s/);
  assert.match(expandedText, /Saved reasoning body\./);
  assert.match(expandedText, /Saved answer\./);
  assert.equal(expanded.find((line) => /Thought for/.test(line.text)).reasoningFor, 'm1');
});

test('layout: no reasoning keeps the honest Thinking/Typing fallback', () => {
  const typing = buildChatLines({ width: 80, messages: [], draft: { content: 'Hello' } });
  const text = typing.map((line) => line.text).join('\n');
  assert.match(text, /Typing\.\.\./);
  assert.equal(text.includes('Reasoning'), false);
  assert.equal(text.includes('MIKUHOST ENGINE'), false);
});

test('attachments: selection cycles, stays visible and removes only the chosen card', () => {
  const settings = pasteSettings({});
  const attachments = [
    createPastedAttachment('const a = 1;\n'.repeat(40), { settings }),
    createPastedAttachment('const b = 2;\n'.repeat(40), { settings }),
    createPastedAttachment('const c = 3;\n'.repeat(40), { settings }),
  ];
  const items = attachments.map((attachment) => ({ kind: 'attachment', id: attachment.id }));

  assert.equal(cycleSelection(null, items), items[0]);
  assert.equal(cycleSelection(items[0], items), items[1]);
  assert.equal(cycleSelection(items[2], items), null, 'Tab returns to the composer after the last card');
  assert.equal(cycleSelection(null, items, -1), items[2]);
  assert.equal(cycleSelection(items[0], items, -1), items[2]);

  const window = attachmentWindow(attachments, 2, attachments[2].id);
  assert.deepEqual(window.items.map((attachment) => attachment.id), [attachments[2].id]);
  assert.equal(window.hidden, 2);

  const remaining = removeAttachmentById(attachments, attachments[1].id);
  assert.deepEqual(remaining.map((attachment) => attachment.id), [attachments[0].id, attachments[2].id]);

  assert.equal(removeAttachmentById(attachments, 'missing').length, 3);
  assert.equal(removeAttachmentById(attachments, null).length, 3);
});

test('attachments: Escape removes the selected card, never the text or siblings', () => {
  const selected = 'paste_b';
  const action = escapeAction({ selectedAttachmentId: selected, hasInput: true });
  assert.deepEqual(action, { type: 'remove-attachment', id: selected });

  // Modal dialogs own Escape first; a panel beside them still closes normally.
  assert.deepEqual(escapeAction({ modalActive: true, selectedAttachmentId: selected }), { type: 'modal' });
  assert.deepEqual(escapeAction({ panel: 'keys', selectedAttachmentId: selected }), { type: 'close-panel', panel: 'keys' });

  // Without a selected card, Escape keeps its pre-existing behaviour.
  assert.deepEqual(escapeAction({ hasInput: true }), { type: 'clear-input' });
  assert.deepEqual(escapeAction({ hasInput: false }), { type: 'scroll-bottom' });

  // Selecting reasoning then Escape collapses rather than deleting anything.
  assert.deepEqual(escapeAction({ reasoningSelected: true, hasInput: true }), { type: 'collapse-reasoning' });
});

test('paste: terminal-split chunks are batched into one commit', () => {
  let scheduled = null;
  let cancels = 0;
  const commits = [];
  const batcher = createPasteBatcher({
    delayMs: 180,
    commit: (text) => commits.push(text),
    schedule: (fn) => {
      scheduled = fn;
      return 1;
    },
    cancel: () => {
      cancels += 1;
    },
  });

  batcher.feed('function demo() {\n');
  batcher.feed('  return 1;\n');
  batcher.feed('}\n');
  assert.equal(batcher.pending, true);
  assert.equal(batcher.size, 32);
  assert.equal(commits.length, 0, 'nothing is committed while the paste is still arriving');
  assert.ok(cancels >= 2, 'each new chunk restarts the quiet timer');

  scheduled();
  assert.deepEqual(commits, ['function demo() {\n  return 1;\n}\n']);
  assert.equal(batcher.pending, false);

  batcher.feed('tail');
  assert.equal(batcher.flush(), 'tail');
  assert.deepEqual(commits, ['function demo() {\n  return 1;\n}\n', 'tail']);

  batcher.feed('discard me');
  batcher.reset();
  assert.equal(batcher.pending, false);
  assert.equal(batcher.size, 0);
});

test('mobile: a bare ESC is an escape key and never inserted as text', () => {
  const escape = describeKeyEvent('\u001b', '', key({ escape: true }));
  assert.equal(escape.kind, 'escape');

  const text = applyTextInput('keep me', 7, '\u001b', key({ escape: true }), '\u001b');
  assert.deepEqual(text, { changed: false, value: 'keep me', cursor: 7 });

  // Android SSH can deliver ESC and the next key in one write; the escape must
  // still not become part of the prompt buffer.
  const batched = applyTextInput('hello', 5, '\u001b', key({ escape: true }), '\u001b');
  assert.equal(batched.changed, false);
  assert.equal(batched.value, 'hello');
});

test('tui: viewport rows map taps to the right reasoning line', () => {
  const lines = [{ text: 'a' }, { text: 'reasoning', reasoningFor: 'm2' }, { text: 'c' }];
  assert.equal(lineAtRow({ row: 2, topPadding: 1, lines }).reasoningFor, 'm2');
  assert.equal(lineAtRow({ row: 0, topPadding: 1, lines }), null);
  assert.equal(lineAtRow({ row: 9, topPadding: 0, lines }), null);
});

test('runtime: reasoning is persisted with the answer but never sent back to the model', async () => {
  const dir = setConfigDir(tempDir('mikuhost-reasoning-'));
  const root = workspaceFixture();
  try {
    const config = makeConfigStub({ workspace: root });
    const workspace = new Workspace(root);
    const store = openSessionStore({ file: path.join(dir, 'sessions.db') });
    const session = new SessionManager({ store, config, workspace: root });
    session.create({ model: MODEL, workspace: root });
    const credentials = {
      activeEntry: () => ({ id: 'k', name: 'Test', key: 'nvapi-test' }),
      touch: () => {},
      reportFailure: () => {},
    };
    const provider = scriptedProvider([
      [
        { type: 'reasoning', text: 'Secret chain of thought.' },
        { type: 'text', text: 'Visible answer.' },
        { type: 'done', finishReason: 'stop' },
      ],
      [{ type: 'text', text: 'Second answer.' }, { type: 'done', finishReason: 'stop' }],
    ]);
    const runtime = new AgentRuntime({ config, workspace, credentials, session, providerFactory: () => provider });
    const events = [];
    runtime.setEventHandler((event) => events.push(event));

    await runtime.send('first');
    assert.equal(session.messages[1].meta.reasoning, 'Secret chain of thought.');
    assert.equal(session.messages[1].meta.completed, true);
    assert.ok(events.some((event) => event.type === EVENTS.REASONING_CHUNK));

    await runtime.send('second');

    // The second request carries the visible answer, never the reasoning field.
    const secondCall = provider.calls[1].messages.map((message) => message.content ?? '').join('\n');
    assert.equal(secondCall.includes('Secret chain of thought.'), false);
    assert.match(secondCall, /Visible answer\./);

    store.close();

    const reopened = openSessionStore({ file: path.join(dir, 'sessions.db') });
    const restored = reopened.getMessages(session.id);
    reopened.close();
    assert.equal(restored[1].meta.reasoning, 'Secret chain of thought.');
    assert.match(restored[1].content, /Visible answer\./);
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('runtime: reasoning mode off persists no reasoning and still completes', async () => {
  const dir = setConfigDir(tempDir('mikuhost-reasoning-off-'));
  const root = workspaceFixture();
  try {
    const config = makeConfigStub({ workspace: root, ui: { reasoning: { mode: 'off' } } });
    const workspace = new Workspace(root);
    const store = openSessionStore({ file: path.join(dir, 'sessions.db') });
    const session = new SessionManager({ store, config, workspace: root });
    session.create({ model: MODEL, workspace: root });
    const credentials = {
      activeEntry: () => ({ id: 'k', name: 'Test', key: 'nvapi-test' }),
      touch: () => {},
      reportFailure: () => {},
    };
    const provider = scriptedProvider([
      [
        { type: 'reasoning', text: 'must not persist' },
        { type: 'text', text: 'answer' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const runtime = new AgentRuntime({ config, workspace, credentials, session, providerFactory: () => provider });
    const events = [];
    runtime.setEventHandler((event) => events.push(event));
    const result = await runtime.send('hi');
    assert.equal(result.text, 'answer');
    assert.equal(result.error, null);
    assert.equal(session.messages[1].meta.reasoning, undefined);
    assert.equal(events.some((event) => event.type === EVENTS.REASONING_CHUNK), false);
    assert.equal(events.filter((event) => event.type === 'phase').at(-1).phase, PHASES.COMPLETED);
    store.close();
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});
