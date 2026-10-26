import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runAgentLoop, extractProtocolToolCalls, ToolProtocolFilter } from '../src/core/agent-loop.mjs';
import { ProviderError, ERROR_CODES } from '../src/providers/errors.mjs';
import { compactMessages, buildSystemPrompt, historyToApi, findUnfinishedTurn } from '../src/core/context.mjs';
import { AgentRuntime } from '../src/core/agent.mjs';
import { PHASES } from '../src/core/events.mjs';
import { SessionManager } from '../src/sessions/manager.mjs';
import { openSessionStore } from '../src/sessions/database.mjs';
import { Workspace } from '../src/security/workspace.mjs';
import { makeConfigStub, workspaceFixture, tempDir, cleanupDir, setConfigDir, startMockServer, sendSse } from './helpers.mjs';
import { CredentialManager } from '../src/credentials/manager.mjs';

function scriptedProvider(turns) {
  const calls = [];
  return {
    calls,
    async *streamChat(options) {
      calls.push(options);
      const turn = turns[Math.min(calls.length - 1, turns.length - 1)];
      if (typeof turn === 'function') {
        const events = await turn(options);
        for (const event of events) yield event;
        return;
      }
      for (const event of turn) yield event;
    },
  };
}

const baseMessages = [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }];

test('agent loop: native tool calls are executed and fed back', async () => {
  const provider = scriptedProvider([
    [
      { type: 'text', text: 'Checking the project.' },
      {
        type: 'done',
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } },
        ],
      },
    ],
    [
      { type: 'text', text: 'It uses baileys.' },
      { type: 'usage', usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } },
      { type: 'done', finishReason: 'stop' },
    ],
  ]);
  const executed = [];
  const events = [];
  const result = await runAgentLoop({
    provider,
    model: 'z-ai/glm-5.3-flash',
    messages: baseMessages,
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    executeTool: async (name, input) => {
      executed.push({ name, input });
      return { ok: true, output: '{"name":"ourin"}', meta: { path: 'package.json' } };
    },
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.error, null);
  assert.equal(result.text, 'It uses baileys.');
  assert.equal(result.toolMode, 'native');
  assert.equal(result.iterations, 2);
  assert.deepEqual(executed, [{ name: 'read_file', input: { path: 'package.json' } }]);
  assert.deepEqual(result.toolsUsed, ['read_file']);
  assert.deepEqual(result.appended.map((message) => message.role), ['assistant', 'tool', 'assistant']);
  assert.equal(result.appended[0].meta.toolCalls.length, 1);
  assert.equal(result.appended[1].toolName, 'read_file');
  assert.match(result.appended[1].content, /ourin/);
  assert.equal(result.usage.totalTokens, 25);
  assert.ok(events.some((event) => event.type === 'tool-start'));
  assert.ok(events.some((event) => event.type === 'tool-end' && event.ok));
  assert.ok(events.some((event) => event.type === 'done'));
  const phases = events.filter((event) => event.type === 'phase').map((event) => event.phase);
  assert.deepEqual(phases, [
    PHASES.THINKING,
    PHASES.STREAMING,
    PHASES.TOOL_EXECUTION,
    PHASES.THINKING,
    PHASES.STREAMING,
    PHASES.COMPLETED,
  ]);

  // The second request carries the assistant tool call and the tool result.
  const second = provider.calls[1].messages;
  assert.equal(second.some((message) => message.role === 'tool' && message.tool_call_id === 'c1'), true);
});

test('agent loop: text tool protocol works when native tools are unavailable', async () => {
  const protocolText = `<tool_call>{"name":"read_file","arguments":{"path":"package.json"}}</tool_call>Package uses baileys.`;
  const provider = scriptedProvider([
    [
      { type: 'text', text: protocolText },
      { type: 'done', finishReason: 'stop' },
    ],
    [
      { type: 'text', text: 'Done — the dependency is baileys.' },
      { type: 'done', finishReason: 'stop' },
    ],
  ]);
  const streamed = [];
  const executed = [];
  const result = await runAgentLoop({
    provider,
    model: 'stepfun-ai/step-5-preview',
    messages: baseMessages,
    toolMode: 'fallback',
    executeTool: async (name, input) => {
      executed.push({ name, input });
      return { ok: true, output: '{"dependencies":{"baileys":"6.7"}}' };
    },
    onEvent: (event) => {
      if (event.type === 'text') streamed.push(event.text);
    },
  });

  assert.equal(result.error, null);
  assert.equal(result.text, 'Done — the dependency is baileys.');
  assert.equal(executed.length, 1);
  assert.equal(executed[0].name, 'read_file');
  assert.equal(streamed.join('').includes('<tool_call>'), false, 'protocol markup must not be displayed');
  assert.match(result.appended[0].content, /Package uses baileys/);
  const toolTurn = provider.calls[1].messages.find((message) => message.role === 'user' && message.content.startsWith('<tool_result'));
  assert.ok(toolTurn);
  assert.match(toolTurn.content, /baileys/);
});

test('agent loop: switches to fallback when the provider rejects native tools', async () => {
  const provider = scriptedProvider([
    async () => {
      throw new ProviderError('tools are not supported by this model', {
        code: ERROR_CODES.BAD_REQUEST,
        httpStatus: 400,
        detail: 'tools are not supported',
      });
    },
    [
      { type: 'text', text: '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>' },
      { type: 'done', finishReason: 'stop' },
    ],
    [{ type: 'text', text: 'Final answer.' }, { type: 'done', finishReason: 'stop' }],
  ]);
  const events = [];
  const result = await runAgentLoop({
    provider,
    model: 'model',
    messages: baseMessages,
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    executeTool: async () => ({ ok: true, output: 'contents' }),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.toolMode, 'fallback');
  assert.equal(result.text, 'Final answer.');
  assert.ok(events.some((event) => event.type === 'warning' && /tool/i.test(event.message)));
  assert.equal(provider.calls[0].tools.length, 1);
  assert.equal(provider.calls[1].tools, undefined);
});

test('agent loop: malformed tool arguments are reported back to the model', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'done',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'bad', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }],
      },
    ],
    [{ type: 'text', text: 'Let me fix that.' }, { type: 'done', finishReason: 'stop' }],
  ]);
  let executed = 0;
  const result = await runAgentLoop({
    provider,
    model: 'm',
    messages: baseMessages,
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    executeTool: async () => {
      executed += 1;
      return { ok: true, output: '' };
    },
  });
  const toolMessage = result.appended.find((message) => message.role === 'tool');
  assert.equal(executed, 0);
  assert.equal(toolMessage.meta.errorCode, 'INVALID_JSON');
  assert.match(toolMessage.content, /TOOL ERROR/);
  assert.equal(result.text, 'Let me fix that.');
});

test('agent loop: respects the iteration cap', async () => {
  const loopTurn = [
    {
      type: 'done',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
    },
  ];
  const provider = scriptedProvider([loopTurn]);
  const events = [];
  const result = await runAgentLoop({
    provider,
    model: 'm',
    messages: baseMessages,
    maxIterations: 2,
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    executeTool: async () => ({ ok: true, output: 'again' }),
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.iterations, 2);
  assert.equal(provider.calls.length, 2);
  assert.ok(events.some((event) => event.type === 'warning' && /limit of 2/.test(event.message)));
});

test('agent loop: pre-aborted signal never calls the provider', async () => {
  const provider = scriptedProvider([[{ type: 'text', text: 'should not run' }]]);
  const controller = new AbortController();
  controller.abort();
  const events = [];
  const result = await runAgentLoop({
    provider,
    model: 'm',
    messages: baseMessages,
    signal: controller.signal,
    executeTool: async () => ({ ok: true, output: '' }),
    onEvent: (event) => events.push(event),
  });
  assert.equal(provider.calls.length, 0);
  assert.equal(result.aborted, true);
  assert.equal(result.appended.length, 0);
  assert.ok(events.some((event) => event.type === 'done'));
});

test('agent loop: no fake Typing state when streaming is disabled', async () => {
  const provider = scriptedProvider([[{ type: 'text', text: 'full answer' }, { type: 'done', finishReason: 'stop' }]]);
  const events = [];
  const result = await runAgentLoop({
    provider,
    model: 'm',
    messages: baseMessages,
    streaming: false,
    executeTool: async () => ({ ok: true, output: '' }),
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.text, 'full answer');
  assert.equal(events.some((event) => event.type === 'text'), false);
  const phases = events.filter((event) => event.type === 'phase').map((event) => event.phase);
  assert.deepEqual(phases, [PHASES.THINKING, PHASES.COMPLETED]);
});

test('agent loop: non-streaming fallback keeps Thinking, not Typing', async () => {
  const provider = scriptedProvider([
    [
      { type: 'transport', streaming: false },
      { type: 'text', text: 'one-piece answer' },
      { type: 'done', finishReason: 'stop' },
    ],
  ]);
  const events = [];
  const result = await runAgentLoop({
    provider,
    model: 'm',
    messages: baseMessages,
    executeTool: async () => ({ ok: true, output: '' }),
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.text, 'one-piece answer');
  const phases = events.filter((event) => event.type === 'phase').map((event) => event.phase);
  assert.deepEqual(phases, [PHASES.THINKING, PHASES.COMPLETED]);
  const textEvents = events.filter((event) => event.type === 'text');
  assert.equal(textEvents.length, 1);
  assert.equal(textEvents[0].streaming, false);
});

test('agent loop: cancellation ends in the CANCELLED phase', async () => {
  const provider = scriptedProvider([[{ type: 'text', text: 'never' }]]);
  const controller = new AbortController();
  controller.abort();
  const events = [];
  await runAgentLoop({
    provider,
    model: 'm',
    messages: baseMessages,
    signal: controller.signal,
    executeTool: async () => ({ ok: true, output: '' }),
    onEvent: (event) => events.push(event),
  });
  assert.ok(events.some((event) => event.type === 'phase' && event.phase === PHASES.CANCELLED));
});

test('protocol helpers: extraction, validation and stream filtering', () => {
  assert.deepEqual(extractProtocolToolCalls('plain answer'), { cleanText: 'plain answer', calls: [], errors: [] });
  const parsed = extractProtocolToolCalls(
    'before <tool_call>{"name":"read_file","arguments":{"path":"x"}}</tool_call> after',
  );
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.cleanText, 'before  after');

  const broken = extractProtocolToolCalls('<tool_call>{not json}</tool_call>');
  assert.equal(broken.calls.length, 0);
  assert.equal(broken.errors.length, 1);

  const unterminated = extractProtocolToolCalls('<tool_call>{"name":"x"}');
  assert.equal(unterminated.errors.length, 1);

  const filter = new ToolProtocolFilter();
  const visible = filter.feed('<tool_call>{"name":"x"}</tool_call>Hello');
  assert.equal(visible, 'Hello');
  assert.equal(filter.feed(' world'), ' world');
});

test('context: compaction keeps goals, files and recent turns', () => {
  const messages = [];
  for (let index = 0; index < 40; index += 1) {
    messages.push({ role: 'user', content: `request ${index}` });
    messages.push({
      role: 'tool',
      toolName: 'read_file',
      content: index === 5 ? 'TOOL ERROR (NOT_FOUND): missing file' : 'ok',
      meta: { ok: index !== 5, path: `src/file-${index}.js` },
    });
    messages.push({ role: 'assistant', content: `answer ${index}` });
  }
  const result = compactMessages(messages, { threshold: 30, keepRecent: 9 });
  assert.equal(result.compacted, true);
  assert.ok(result.removed > 0);
  assert.equal(result.messages[0].role, 'system');
  assert.match(result.messages[0].content, /request 25/);
  assert.match(result.messages[0].content, /src\/file-0\.js/);
  assert.match(result.messages[0].content, /Last tool error/);
  assert.equal(result.messages.length < messages.length, true);
  assert.equal(result.messages.at(-1).content, 'answer 39');

  const small = compactMessages(messages.slice(0, 4), { threshold: 30 });
  assert.equal(small.compacted, false);
});

test('context: system prompt adapts to tool mode and workspace', () => {
  const native = buildSystemPrompt({
    workspace: '/root',
    focusProject: '/root/ourin',
    projects: [{ relPath: 'ourin', type: 'Node.js' }],
    modelName: 'GLM 5.3 Flash',
    toolMode: 'native',
    toolNames: ['read_file', 'run_command'],
  });
  assert.match(native, /Workspace root: \/root/);
  assert.match(native, /Focused project: \/root\/ourin/);
  assert.match(native, /read_file, run_command/);
  assert.equal(native.includes('<tool_call>'), false);

  const fallback = buildSystemPrompt({ workspace: '/root', toolMode: 'fallback', toolNames: [] });
  assert.match(fallback, /<tool_call>/);
  assert.match(fallback, /<tool_result>/);
});

test('context: history conversion drops orphan tool messages', () => {
  const api = historyToApi([
    { role: 'user', content: 'hi' },
    { role: 'tool', content: 'orphan', meta: { toolCallId: 'x' } },
    { role: 'assistant', content: 'ok' },
  ]);
  assert.deepEqual(api.map((message) => message.role), ['user', 'assistant']);
});

test('agent runtime: compaction summarizes the request but never trims the transcript', async () => {
  const dir = tempDir('mikuhost-compact-');
  const root = workspaceFixture();
  try {
    const config = makeConfigStub({ workspace: root, agent: { compactAfterMessages: 30 } });
    const workspace = new Workspace(root);
    const store = openSessionStore({ file: path.join(dir, 'sessions.db') });
    const session = new SessionManager({ store, config, workspace: root });
    session.create({ model: 'z-ai/glm-5.3-flash', workspace: root });

    for (let index = 0; index < 20; index += 1) {
      session.appendMessage({ role: 'user', content: `request ${index}` });
      session.appendMessage({ role: 'assistant', content: `answer ${index}` });
    }
    const before = session.messages.length;

    const credentials = {
      activeEntry: () => ({ id: 'k', name: 'Test', key: 'nvapi-test' }),
      touch: () => {},
      reportFailure: () => {},
    };
    const provider = scriptedProvider([[{ type: 'text', text: 'done' }, { type: 'done', finishReason: 'stop' }]]);
    const events = [];
    const runtime = new AgentRuntime({ config, workspace, credentials, session, providerFactory: () => provider });
    runtime.setEventHandler((event) => events.push(event));

    await runtime.send('lanjut');

    assert.equal(session.messages.length, before + 2, 'older messages must stay in the transcript');
    assert.equal(session.messages[0].content, 'request 0');

    const sent = provider.calls[0].messages;
    assert.equal(sent[0].role, 'system');
    assert.match(sent[1].content, /compacted locally/);
    assert.match(sent[1].content, /request 0/);
    // The loop appends its own assistant/tool turns to the same array, so the
    // prompt is checked as the last user message rather than the last entry.
    assert.equal(sent.filter((message) => message.role === 'user').at(-1).content, 'lanjut');
    assert.ok(sent.length < before, 'the request itself is compacted');

    await runtime.send('lagi');
    const warnings = events.filter((event) => event.type === 'warning' && /compact/i.test(event.message));
    assert.equal(warnings.length, 1, 'compaction is announced once per session');
    assert.equal(session.messages.length, before + 4);

    store.close();
    const reopened = openSessionStore({ file: path.join(dir, 'sessions.db') });
    assert.equal(reopened.getMessages(session.id).length, before + 4, 'a reopened session keeps every message');
    reopened.close();
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('agent runtime: sends a turn, persists it and honours credentials', async () => {
  const dir = tempDir('mikuhost-runtime-');
  const root = workspaceFixture();
  try {
    const config = makeConfigStub({ workspace: root });
    const workspace = new Workspace(root);
    const store = openSessionStore({ file: path.join(dir, 'sessions.db') });
    const session = new SessionManager({ store, config, workspace: root });
    session.create({ model: 'z-ai/glm-5.3-flash', workspace: root });

    let touched = 0;
    const credentials = {
      activeEntry: () => ({ id: 'k1', name: 'Test', key: 'nvapi-abcdefghijklmnop' }),
      touch: () => {
        touched += 1;
      },
      reportFailure: () => {},
    };
    const provider = scriptedProvider([[{ type: 'text', text: 'Hello from runtime.' }, { type: 'done', finishReason: 'stop' }]]);
    const runtime = new AgentRuntime({
      config,
      workspace,
      credentials,
      session,
      providerFactory: () => provider,
    });
    const events = [];
    runtime.setEventHandler((event) => events.push(event));
    const result = await runtime.send('Cek project ourin');
    assert.equal(result.text, 'Hello from runtime.');
    assert.equal(result.error, null);
    assert.equal(touched, 1);
    assert.equal(session.messages[0].role, 'user');
    assert.equal(session.messages[1].role, 'assistant');
    assert.equal(session.messages[1].content, 'Hello from runtime.');
    assert.equal(session.messages[1].meta.completed, true);
    assert.equal(Number.isFinite(session.messages[1].meta.durationMs), true);
    assert.equal(session.title, 'Cek project ourin');
    assert.ok(provider.calls[0].messages[0].content.includes(root));
    const phases = events.filter((event) => event.type === 'phase').map((event) => event.phase);
    assert.equal(phases[0], PHASES.CONNECTING);
    assert.ok(phases.includes(PHASES.THINKING));
    assert.ok(phases.includes(PHASES.STREAMING));
    assert.equal(phases.at(-1), PHASES.COMPLETED);
    store.close();
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('agent runtime: every turn uses the credential that is active now', async () => {
  const dir = tempDir('mikuhost-switch-');
  const root = workspaceFixture();
  try {
    const config = makeConfigStub({ workspace: root });
    const workspace = new Workspace(root);
    const store = openSessionStore({ file: path.join(dir, 'sessions.db') });
    const session = new SessionManager({ store, config, workspace: root });
    session.create({ model: 'z-ai/glm-5.3-flash', workspace: root });

    let active = { id: 'k1', name: 'Personal', key: 'nvapi-one' };
    const credentials = {
      activeEntry: () => active,
      touch: () => {},
      reportFailure: () => {},
    };
    const used = [];
    const runtime = new AgentRuntime({
      config,
      workspace,
      credentials,
      session,
      providerFactory: (entry) => {
        used.push(entry.key);
        return scriptedProvider([[{ type: 'text', text: `answer for ${entry.name}` }, { type: 'done', finishReason: 'stop' }]]);
      },
    });

    await runtime.send('first');
    active = { id: 'k2', name: 'Backup', key: 'nvapi-two' };
    const second = await runtime.send('second');

    assert.deepEqual(used, ['nvapi-one', 'nvapi-two']);
    assert.equal(second.text, 'answer for Backup');
    store.close();
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('agent runtime: switching the active key changes the next Authorization header', async () => {
  const dir = setConfigDir(tempDir('mikuhost-live-switch-'));
  const root = workspaceFixture();
  const keyOne = `nvapi-${'a'.repeat(32)}`;
  const keyTwo = `nvapi-${'b'.repeat(32)}`;
  const server = await startMockServer((req, res) => {
    sendSse(res, [
      { choices: [{ index: 0, delta: { content: 'ok' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);
  });
  try {
    const config = makeConfigStub({ workspace: root, baseUrl: server.url });
    const workspace = new Workspace(root);
    const store = openSessionStore({ file: path.join(dir, 'sessions.db') });
    const session = new SessionManager({ store, config, workspace: root });
    session.create({ model: 'z-ai/glm-5.3-flash', workspace: root });
    const credentials = new CredentialManager();
    const one = credentials.add({ name: 'Personal', key: keyOne });
    const two = credentials.add({ name: 'Backup', key: keyTwo });
    credentials.setActive(one.id);

    const runtime = new AgentRuntime({ config, workspace, credentials, session });
    await runtime.send('first');
    credentials.setActive(two.id);
    await runtime.send('second');

    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[0].headers.authorization, `Bearer ${keyOne}`);
    assert.equal(server.requests[1].headers.authorization, `Bearer ${keyTwo}`);
    assert.equal(credentials.activeEntry().name, 'Backup');
    store.close();
  } finally {
    await server.close();
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('agent runtime: approval emits WAITING_APPROVAL and executes only after a decision', async () => {
  const dir = tempDir('mikuhost-approval-');
  const root = workspaceFixture();
  try {
    const config = makeConfigStub({ workspace: root });
    const workspace = new Workspace(root);
    const store = openSessionStore({ file: path.join(dir, 'sessions.db') });
    const session = new SessionManager({ store, config, workspace: root });
    session.create({ model: 'z-ai/glm-5.3-flash', workspace: root });

    const provider = scriptedProvider([
      [
        {
          type: 'done',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{"command":"npm install left-pad"}' } },
          ],
        },
      ],
      [{ type: 'text', text: 'Command was denied.' }, { type: 'done', finishReason: 'stop' }],
    ]);
    const credentials = {
      activeEntry: () => ({ id: 'k1', name: 'Test', key: 'nvapi-test' }),
      touch: () => {},
      reportFailure: () => {},
    };
    const events = [];
    const runtime = new AgentRuntime({
      config,
      workspace,
      credentials,
      session,
      providerFactory: () => provider,
      approvalHandler: async () => false,
    });
    runtime.setEventHandler((event) => events.push(event));

    const result = await runtime.send('run echo');
    assert.equal(result.text, 'Command was denied.');
    assert.ok(events.some((event) => event.type === 'tool-approval'));
    const phases = events.filter((event) => event.type === 'phase').map((event) => event.phase);
    const waiting = phases.indexOf(PHASES.WAITING_APPROVAL);
    const workingAfter = phases.lastIndexOf(PHASES.TOOL_EXECUTION);
    assert.ok(waiting >= 0, 'approval phase must be reported');
    assert.ok(workingAfter > waiting, 'tool work resumes after the approval dialog is answered');
    assert.ok(events.some((event) => event.type === 'tool-end' && event.ok === false));
    store.close();
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});

test('agent loop: no iteration cap by default, so long tasks finish', async () => {
  const toolTurn = [
    {
      type: 'done',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
    },
  ];
  const rounds = 25;
  const provider = scriptedProvider([...Array.from({ length: rounds }, () => toolTurn), [
    { type: 'text', text: 'finished the whole task' },
    { type: 'done', finishReason: 'stop' },
  ]]);
  const events = [];
  const result = await runAgentLoop({
    provider,
    model: 'm',
    messages: baseMessages,
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    executeTool: async () => ({ ok: true, output: 'again' }),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.iterations, rounds + 1);
  assert.equal(provider.calls.length, rounds + 1);
  assert.equal(result.text, 'finished the whole task');
  assert.equal(
    events.some((event) => event.type === 'warning' && /limit of .* iterations/.test(event.message)),
    false,
    'no cap warning when the loop is unlimited',
  );
});

test('context: findUnfinishedTurn flags only a prompt that never got an answer', () => {
  assert.equal(findUnfinishedTurn([]), null);
  assert.equal(findUnfinishedTurn([{ role: 'user', content: 'do it' }]).content, 'do it');
  assert.equal(
    findUnfinishedTurn([{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'done' }]),
    null,
  );
  const cutOff = findUnfinishedTurn([
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: '', meta: { toolCalls: [{ id: 'c1' }] } },
    { role: 'tool', content: 'read ok', meta: { toolCallId: 'c1' } },
  ]);
  assert.equal(cutOff.content, 'do it', 'a turn that stopped after tools is unfinished');
  assert.equal(
    findUnfinishedTurn([
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: 'partial', meta: { aborted: true } },
    ]),
    null,
    'a partial answer from an explicit Ctrl+C counts as answered',
  );
  assert.equal(
    findUnfinishedTurn([{ role: 'user', content: 'do it' }, { role: 'system', content: 'notice' }]).content,
    'do it',
  );
});

test('agent runtime: continueTurn resumes an unanswered prompt without duplicating it', async () => {
  const dir = tempDir('mikuhost-continue-');
  const root = workspaceFixture();
  try {
    const config = makeConfigStub({ workspace: root });
    const workspace = new Workspace(root);
    const store = openSessionStore({ file: path.join(dir, 'sessions.db') });
    const session = new SessionManager({ store, config, workspace: root });
    session.create({ model: 'z-ai/glm-5.3-flash', workspace: root });
    session.appendMessage({ role: 'user', content: 'Fix the reconnection bug' });

    const credentials = {
      activeEntry: () => ({ id: 'k', name: 'Test', key: 'nvapi-test' }),
      touch: () => {},
      reportFailure: () => {},
    };
    const provider = scriptedProvider([[{ type: 'text', text: 'Here is the fix.' }, { type: 'done', finishReason: 'stop' }]]);
    const runtime = new AgentRuntime({ config, workspace, credentials, session, providerFactory: () => provider });

    assert.equal(findUnfinishedTurn(session.messages).content, 'Fix the reconnection bug');
    const result = await runtime.continueTurn();
    assert.equal(result.text, 'Here is the fix.');
    assert.equal(result.error, null);

    const sent = provider.calls[0].messages;
    const sentUser = sent.filter((message) => message.role === 'user');
    assert.equal(sentUser.length, 1, 'the prompt is sent once, not appended again');
    assert.equal(sentUser[0].content, 'Fix the reconnection bug');
    assert.equal(session.messages.filter((message) => message.role === 'user').length, 1);
    assert.equal(session.messages.at(-1).role, 'assistant');
    assert.equal(session.messages.at(-1).content, 'Here is the fix.');
    assert.equal(findUnfinishedTurn(session.messages), null, 'the turn is complete now');

    await assert.rejects(() => runtime.continueTurn(), /no unfinished turn/i);
    store.close();
  } finally {
    cleanupDir(dir);
    cleanupDir(root);
  }
});
