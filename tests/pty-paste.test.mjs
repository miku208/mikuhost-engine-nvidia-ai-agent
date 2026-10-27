// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openSessionStore } from '../src/sessions/database.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAS_SCRIPT = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0;
const LINE = 'const handler = async (event) => {\n  return event?.id ?? null;\n};\n';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}

function payload(size) {
  let text = '';
  while (text.length < size) text += LINE;
  return text.slice(0, size);
}

function stripAnsi(text) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function chunked(text, seed = 11, min = 1, max = 4096) {
  let state = seed;
  const chunks = [];
  let index = 0;
  while (index < text.length) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const size = min + (state % (max - min + 1));
    chunks.push(text.slice(index, index + size));
    index += size;
  }
  return chunks;
}

async function startMockServer({ toolCall = null, toolCalls = null } = {}) {
  const requests = [];
  const raw = [];
  const calls = toolCalls ?? (toolCall ? [toolCall] : []);
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      requests.push(parsed);
      raw.push({ headers: { ...req.headers }, body: parsed });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // The first turn may ask for tool calls, so an approval dialog (one call)
      // or a multi-file turn (several calls) can be exercised; after that the
      // model answers normally and the loop ends.
      if (calls.length && requests.length === 1) {
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: calls.map((call, index) => ({
                    index,
                    id: `call_${index + 1}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                  })),
                },
              },
            ],
          })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'OK' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    /** Requests with their headers, for provider/credential assertions. */
    raw,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function fixture(prefix, baseUrl, { keys = null, permissions = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configDir = path.join(root, 'config');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(configDir, 'logs'), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      version: 1,
      setupComplete: true,
      workspace,
      provider: 'nvidia',
      // Every provider points at the mock server so a key switch (which also
      // switches provider) never reaches the real internet during a test.
      providers: { nvidia: { baseUrl }, tokenharbor: { baseUrl }, custom: { baseUrl } },
      defaultModel: 'z-ai/glm-5.3-flash',
      permissions: permissions ?? { shell: 'ask', fileWrite: 'ask', sensitiveRead: 'ask' },
      ui: { mouse: false },
    }),
  );
  const storedKeys = keys ?? [
    { id: 'k1', name: 'PTY', key: 'nvapi-pty-test-1234567890abcdef', createdAt: 1, status: 'ready' },
  ];
  fs.writeFileSync(
    path.join(configDir, 'credentials.json'),
    JSON.stringify({ version: 1, activeId: storedKeys[0].id, keys: storedKeys }),
  );
  return { root, configDir, workspace };
}

/** Run the real TUI inside a PTY via util-linux `script`, which forwards stdin. */
function launch(fixtureDir, extraArgs = []) {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, 'bin', 'mikuhost.mjs'))} --workspace ${JSON.stringify(fixtureDir.workspace)}${extraArgs.map((arg) => ` ${JSON.stringify(arg)}`).join('')}`;
  const child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], {
    cwd: ROOT,
    env: {
      ...process.env,
      MIKUHOST_CONFIG_DIR: fixtureDir.configDir,
      MIKUHOST_MOUSE: '0',
      TERM: 'xterm-256color',
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  // The PTY closes as soon as the app exits; a write racing with that exit must
  // not crash the test process.
  child.stdin.on('error', () => {});
  child.stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  return {
    child,
    fixtureDir,
    get output() {
      return stripAnsi(output);
    },
    write(text) {
      child.stdin.write(text);
    },
    async stop() {
      try {
        child.stdin.write('\x03');
        await sleep(150);
        child.stdin.write('\x03');
      } catch {
        /* already gone */
      }
      await sleep(200);
      child.kill('SIGKILL');
      fs.rmSync(fixtureDir.root, { recursive: true, force: true });
    },
  };
}

async function startPty(prefix, options = {}) {
  const server = await startMockServer({ toolCall: options.toolCall ?? null, toolCalls: options.toolCalls ?? null });
  const fixtureDir = fixture(prefix, server.url, options);
  const tui = launch(fixtureDir, options.args ?? []);
  const ready = await waitFor(() => /MIKUHOST AGENT/.test(tui.output));
  assert.ok(ready, `TUI did not start:\n${tui.output.slice(-2000)}`);
  return { tui, server };
}

function lastUserContent(server) {
  const request = [...server.requests].reverse().find((entry) => entry?.messages);
  assert.ok(request, 'the mock provider did not receive a chat request');
  return request.messages.filter((message) => message.role === 'user').at(-1).content;
}

function assertFullContent(content, pasted, prompt) {
  if (prompt) assert.ok(content.startsWith(prompt), 'the prompt must be preserved before the attachment');
  assert.ok(content.includes(pasted), 'the full pasted source must reach the model');
  assert.equal(content.split(pasted).length - 1, 1, 'the pasted source must appear exactly once');
}

test('pty: 23,814 chars without bracketed markers become one attachment, prompt untouched', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-plain-');
  try {
    const content = payload(23_814);
    tui.write('Cek bug ini');
    await sleep(450);
    for (const chunk of chunked(content, 11, 1, 4096)) {
      tui.write(chunk);
      await sleep(8);
    }
    await sleep(1200);

    const screen = tui.output;
    assert.match(screen, /Pasted 23,814 characters as a JavaScript attachment/);
    assert.match(screen, /\[JS · 23,814 chars\]/);
    assert.match(screen, /Cek bug ini/);
    assert.equal(screen.includes('const handler'), false, 'pasted code leaked into the composer or transcript');
    // No marker was sent, so the footer must not claim bracketed support.
    assert.match(screen, /bracketed \?/);
    assert.equal(/bracketed ✓/.test(screen), false, 'a plain paste must not be reported as bracketed');
    assert.equal(tui.child.exitCode, null, 'the TUI must stay alive');

    tui.write('\t');
    await sleep(250);
    tui.write('\u001b');
    await sleep(400);
    assert.match(tui.output, /Removed \[JS · 23,814 chars\]/);
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: 80,000 chars stay in one attachment and are refused at send, never split', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-limit-');
  try {
    const content = payload(80_000);
    tui.write('Cek bug ini');
    await sleep(450);
    for (const chunk of chunked(content, 47, 512, 4096)) {
      tui.write(chunk);
      await sleep(8);
    }
    await sleep(1200);

    let screen = tui.output;
    assert.match(screen, /\[JS · 80,000 chars\]/);
    assert.equal(screen.includes('const handler'), false, 'over-limit paste leaked into the composer');

    tui.write('\r');
    await sleep(700);
    screen = tui.output;
    assert.match(screen, /above the 60,000 character context\s+limit/);
    assert.match(screen, /Cek bug ini/);
    assert.equal(screen.includes('const handler'), false, 'over-limit paste was dumped into the editor');
    assert.equal(tui.child.exitCode, null, 'the TUI must stay alive after the size error');
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: bracketed 30,000 chars with long SSH gaps stays one attachment', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-gap-');
  try {
    const content = payload(30_000);
    tui.write('Cek bug ini');
    await sleep(450);
    tui.write('\u001b[200~');
    for (let index = 0; index < content.length; index += 4096) {
      tui.write(content.slice(index, index + 4096));
      await sleep(320);
    }
    tui.write('\u001b[201~');
    await sleep(800);

    const screen = tui.output;
    assert.match(screen, /\[JS · 30,000 chars\]/);
    assert.equal(screen.includes('const handler'), false);

    tui.write('\r');
    await sleep(900);
    assertFullContent(lastUserContent(server), content, 'Cek bug ini');
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: 60,000 chars in random reads reaches the model byte-for-byte', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-60k-');
  try {
    const content = payload(60_000);
    tui.write('Cek bug ini');
    await sleep(450);
    for (const chunk of chunked(content, 71, 128, 4096)) {
      tui.write(chunk);
      await sleep(8);
    }
    await sleep(1200);
    assert.match(tui.output, /\[JS · 60,000 chars\]/);

    tui.write('\r');
    await sleep(1400);
    assertFullContent(lastUserContent(server), content, 'Cek bug ini');
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: markers split into single bytes keep prompt and full content', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-bytes-');
  try {
    const content = payload(10_206);
    tui.write('Cek bug ini');
    await sleep(450);
    for (const byte of Buffer.from('\u001b[200~')) {
      tui.write(Buffer.from([byte]));
      await sleep(4);
    }
    for (let index = 0; index < content.length; index += 700) {
      tui.write(content.slice(index, index + 700));
      await sleep(4);
    }
    for (const byte of Buffer.from('\u001b[201~')) {
      tui.write(Buffer.from([byte]));
      await sleep(4);
    }
    await sleep(800);

    const screen = tui.output;
    assert.match(screen, /\[JS · 10,206 chars\]/);
    assert.match(screen, /Cek bug ini/);
    assert.equal(screen.includes('const handler'), false);

    tui.write('\r');
    await sleep(900);
    assertFullContent(lastUserContent(server), content, 'Cek bug ini');
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: two separate bracketed pastes produce two attachments', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-two-');
  try {
    const first = `const first = '${'a'.repeat(600)}';\n`;
    const second = `const second = '${'b'.repeat(600)}';\n\u001b[31m// red\u001b[0m\n`;
    tui.write('Cek bug ini');
    await sleep(450);
    tui.write(`\u001b[200~${first}\u001b[201~`);
    await sleep(400);
    tui.write(`\u001b[200~${second}\u001b[201~`);
    await sleep(700);

    const screen = tui.output;
    assert.match(screen, /\[JS · [\d,]+ chars\]/);
    assert.equal(screen.includes('const first'), false);

    tui.write('\r');
    await sleep(350);
    tui.write('\r');
    await sleep(1200);
    const trace = fs.existsSync(path.join(tui.fixtureDir.configDir, 'logs', 'input-trace.log'))
      ? fs.readFileSync(path.join(tui.fixtureDir.configDir, 'logs', 'input-trace.log'), 'utf8').split('\n').slice(-8).join('\n')
      : 'no trace';
    assert.ok(server.requests.length, `no chat request was sent.\n${tui.output.slice(-2500)}\n${trace}`);
    const request = lastUserContent(server);
    assert.ok(request.includes(first));
    assert.ok(request.includes(second));
    assert.equal(request.split(first).length - 1, 1);
    assert.equal(request.split(second).length - 1, 1);
    assert.equal((request.match(/<pasted_text/g) ?? []).length, 2, 'two attachments must be sent');
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: /paste ends with Ctrl+D and preserves multiline content', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-capture-');
  try {
    const content = payload(10_206);
    tui.write('/paste');
    await sleep(300);
    tui.write('\r');
    await sleep(500);
    assert.match(tui.output, /Paste capture/);

    for (const chunk of chunked(content, 13, 200, 2048)) {
      tui.write(chunk);
      await sleep(5);
    }
    await sleep(500);
    tui.write('\u0004');
    await sleep(700);

    const screen = tui.output;
    assert.match(screen, /\[JS · 10,206 chars\]/);
    assert.equal(screen.includes('const handler'), false);

    tui.write('\r');
    await sleep(900);
    const request = lastUserContent(server);
    assertFullContent(request, content, null);
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: paste and Enter in one read submit the attachment exactly once', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-paste-enter-');
  try {
    const content = payload(5_204);
    tui.write('Cek bug ini');
    await sleep(450);
    tui.write(`\u001b[200~${content}\u001b[201~\r`);
    await sleep(1200);

    const request = lastUserContent(server);
    assert.ok(request.startsWith('Cek bug ini'));
    assert.equal(request.split(content).length - 1, 1);
    assert.equal((request.match(/<pasted_text/g) ?? []).length, 1);
    assert.equal(tui.output.includes('const handler'), false);
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: /paste capture accepts a bracketed block and keeps it as one attachment', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-capture-bracket-');
  try {
    const content = payload(6_204);
    tui.write('/paste');
    await sleep(300);
    tui.write('\r');
    await sleep(500);
    assert.match(tui.output, /Paste capture/);

    tui.write('\u001b[200~');
    for (let index = 0; index < content.length; index += 900) {
      tui.write(content.slice(index, index + 900));
      await sleep(30);
    }
    tui.write('\u001b[201~');
    await sleep(400);
    tui.write('\u0004');
    await sleep(700);

    const screen = tui.output;
    assert.match(screen, /\[JS · 6,204 chars\]/);
    assert.equal(screen.includes('const handler'), false);

    tui.write('\r');
    await sleep(900);
    assertFullContent(lastUserContent(server), content, null);
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: a key pasted into the Add-key field is stored there, not in the chat composer', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-key-paste-');
  const KEY = 'thk_ptyHarborKey0123456789abcdef';
  try {
    tui.write('/keys');
    await sleep(300);
    tui.write('\r');
    await sleep(500);
    assert.match(tui.output, /API KEY MANAGER/);

    tui.write('a');
    await sleep(400);
    assert.match(tui.output, /Key name/);
    tui.write('Harbor');
    await sleep(200);
    tui.write('\r');
    await sleep(400);
    assert.match(tui.output, /API key for "Harbor"/);

    // A copied key arrives wrapped in bracketed-paste markers and usually
    // carries a trailing newline from the copy.
    tui.write(`\u001b[200~${KEY}\r\n\u001b[201~`);
    await sleep(500);
    // The key field is shown in clear on purpose: a swallowed or truncated
    // character is impossible to spot behind bullets.
    assert.ok(tui.output.includes(KEY), 'the key field must show the full key');
    assert.match(tui.output, new RegExp(`${KEY.length} characters`));

    tui.write('\r');
    await sleep(1500);
    // Saving verifies with a real completion against the provider.
    assert.match(tui.output, /key accepted by TokenHarbor/);
    assert.match(tui.output, /thk_•+/, 'the stored list entry stays masked');
    const stored = JSON.parse(
      fs.readFileSync(path.join(tui.fixtureDir.configDir, 'credentials.json'), 'utf8'),
    );
    const added = stored.keys.find((entry) => entry.name === 'Harbor');
    assert.ok(added, 'the pasted key must be stored from the prompt field');
    assert.equal(added.key, KEY, 'terminal whitespace must be stripped from the stored key');
    assert.equal(added.provider, 'tokenharbor');

    // The composer behind the panel stayed empty: Esc then a message sends only
    // that message.
    tui.write('\u001b');
    await sleep(500);
    tui.write('halo');
    await sleep(600);
    tui.write('\r');
    await sleep(1000);
    const content = lastUserContent(server);
    assert.equal(content, 'halo');
    assert.equal(content.includes(KEY), false, 'the key must never be sent as a chat message');
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: choosing a model switches the API key to that model provider', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-model-key-', {
    keys: [
      { id: 'k_nv', name: 'Personal', key: 'nvapi-pty-test-1234567890abcdef', provider: 'nvidia', createdAt: 1, status: 'ready' },
      { id: 'k_th', name: 'Harbor', key: 'thk_ptyHarborKey0123456789abcdef', provider: 'tokenharbor', createdAt: 2, status: 'ready' },
    ],
  });
  const readStore = () =>
    JSON.parse(fs.readFileSync(path.join(tui.fixtureDir.configDir, 'credentials.json'), 'utf8'));
  try {
    assert.equal(readStore().activeId, 'k_nv');
    tui.write('/models');
    await sleep(300);
    tui.write('\r');
    await sleep(600);

    const screen = tui.output;
    assert.match(screen, /SELECT MODEL/);
    // Both providers are reachable from the panel: the active key is NVIDIA.
    assert.match(screen, /NVIDIA · unverified/);
    assert.match(screen, /TokenHarbor · unverified/);
    assert.match(screen, /DeepSeek V4\.1 Flash \(free\)/);

    // Up from the first row wraps to the last: TokenHarbor's DeepSeek model.
    tui.write('\u001b[A');
    await sleep(300);
    tui.write('\r');
    await sleep(700);
    assert.equal(readStore().activeId, 'k_th', 'the TokenHarbor key must be selected automatically');
    assert.match(tui.output, /TokenHarbor key Harbor/);

    // The next request is authenticated with the TokenHarbor key.
    tui.write('halo');
    await sleep(600);
    tui.write('\r');
    await sleep(1200);
    assert.equal(server.raw.at(-1).headers.authorization, 'Bearer thk_ptyHarborKey0123456789abcdef');
    assert.equal(server.raw.at(-1).body.model, 'deepseek-v4.1-flash:free');

    // And the first row (GLM on NVIDIA) switches the key back.
    tui.write('/models');
    await sleep(300);
    tui.write('\r');
    await sleep(600);
    tui.write('\r');
    await sleep(700);
    assert.equal(readStore().activeId, 'k_nv', 'the NVIDIA key must be selected automatically');

    tui.write('halo lagi');
    await sleep(600);
    tui.write('\r');
    await sleep(1200);
    assert.equal(server.raw.at(-1).headers.authorization, 'Bearer nvapi-pty-test-1234567890abcdef');
    assert.equal(server.raw.at(-1).body.model, 'z-ai/glm-5.3-flash');
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: bracketed 10,206 chars split into random reads is one attachment', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-bracket-');
  try {
    const content = payload(10_206);
    tui.write('Cek bug ini');
    await sleep(450);
    tui.write('\u001b[200~');
    for (const chunk of chunked(content, 29, 1, 2048)) {
      tui.write(chunk);
      await sleep(4);
    }
    tui.write('\u001b[201~');
    await sleep(900);

    const screen = tui.output;
    assert.match(screen, /Pasted 10,206 characters as a JavaScript attachment/);
    assert.match(screen, /\[JS · 10,206 chars\]/);
    assert.match(screen, /Cek bug ini/);
    assert.match(screen, /bracketed ✓/, 'the composer footer must show that markers were received');
    assert.equal(screen.includes('const handler'), false, 'bracketed paste leaked into the composer');

    tui.write('\r');
    await sleep(900);
    assertFullContent(lastUserContent(server), content, 'Cek bug ini');
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: settings → Unattended mode auto-approves everything and persists', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-unattended-');
  const configFile = path.join(tui.fixtureDir.configDir, 'config.json');
  try {
    await sleep(400);
    tui.write('/settings');
    await sleep(400);
    tui.write('\r');
    assert.ok(await waitFor(() => /MIKUHOST SETTINGS/.test(tui.output)), `settings panel did not open:\n${tui.output.slice(-2000)}`);
    assert.match(tui.output, /Leave the agent running/);

    // Four rows: shell, file writes, sensitive reads, then the unattended switch.
    for (let index = 0; index < 3; index += 1) {
      tui.write('\u001b[B');
      await sleep(120);
    }
    tui.write('\r');
    assert.ok(
      await waitFor(() => /ENABLE UNATTENDED MODE\?/.test(tui.output)),
      `confirmation did not appear:\n${tui.output.slice(-2000)}`,
    );
    tui.write('y');
    await sleep(500);

    let saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(saved.permissions.shell, 'auto');
    assert.equal(saved.permissions.fileWrite, 'auto');
    assert.equal(saved.permissions.sensitiveRead, 'auto');
    assert.match(tui.output, /nothing is asked/);

    // Pressing Enter again turns it back off: approvals return.
    tui.write('\r');
    await sleep(500);
    saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(saved.permissions.shell, 'ask');
    assert.equal(saved.permissions.fileWrite, 'ask');
    assert.equal(saved.permissions.sensitiveRead, 'ask');
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: /permissions shell auto asks first, then persists only that policy', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-permissions-');
  const configFile = path.join(tui.fixtureDir.configDir, 'config.json');
  try {
    await sleep(400);
    tui.write('/permissions shell auto');
    await sleep(400);
    tui.write('\r');
    assert.ok(
      await waitFor(() => /ENABLE UNATTENDED MODE\?/.test(tui.output)),
      `the confirmation dialog did not appear:\n${tui.output.slice(-2000)}`,
    );
    let saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(saved.permissions.shell, 'ask', 'nothing changes before the confirmation');

    tui.write('y');
    await sleep(600);
    saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(saved.permissions.shell, 'auto');
    assert.equal(saved.permissions.fileWrite, 'ask');
    assert.equal(saved.permissions.sensitiveRead, 'ask');
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: the approval dialog shows the whole command, wrapped, not cut off', { skip: !HAS_SCRIPT }, async () => {
  const command = 'echo "=== src/lib (jumlah file) ==="; ls src/lib | wc -l; ls src/lib/*.js 2>/dev/null | head -5';
  const { tui, server } = await startPty('mikuhost-pty-approval-', {
    toolCall: { name: 'run_command', arguments: { command } },
  });
  try {
    await sleep(400);
    tui.write('cek jumlah file di src/lib');
    await sleep(300);
    tui.write('\r');
    assert.ok(
      await waitFor(() => /SHELL EXECUTION REQUEST/.test(tui.output)),
      `the approval dialog did not appear:\n${tui.output.slice(-2000)}`,
    );
    const screen = tui.output;
    // The command is longer than the dialog line: it must wrap, and every part
    // of it (including the /dev/null redirect) has to be readable.
    assert.match(screen, /Command:/);
    assert.ok(screen.includes('echo "=== src/lib (jumlah file) ==="'), 'the start of the command must be visible');
    assert.ok(screen.includes('2>/dev/null | head -5'), 'the end of the command must be visible');
    assert.match(screen, /ALWAYS ASK · read-only/);

    tui.write('d');
    await sleep(900);
    assert.equal(tui.child.exitCode, null, 'the TUI must stay alive after denying');
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: /undo restores the file the agent just overwrote', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-undo-', {
    toolCall: { name: 'write_file', arguments: { path: 'catatan.txt', content: 'ditulis agen\n' } },
  });
  const target = path.join(tui.fixtureDir.workspace, 'catatan.txt');
  try {
    fs.writeFileSync(target, 'isi asli\n');
    await sleep(400);
    tui.write('tulis catatan');
    await sleep(300);
    tui.write('\r');
    assert.ok(
      await waitFor(() => /FILE CHANGE REQUEST/.test(tui.output)),
      `the write approval never appeared:\n${tui.output.slice(-2000)}`,
    );
    tui.write('a');
    assert.ok(
      await waitFor(() => fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'ditulis agen\n'),
      'the agent did not write the file',
    );
    assert.ok(await waitFor(() => /Completed in/.test(tui.output)), 'the turn never finished');

    tui.write('/undo');
    await sleep(300);
    tui.write('\r');
    assert.ok(
      await waitFor(() => fs.readFileSync(target, 'utf8') === 'isi asli\n'),
      `the original content was not restored:\n${tui.output.slice(-2000)}`,
    );
    assert.match(tui.output, /Restored catatan\.txt to the version before write_file/);
    assert.match(tui.output, /Undo: restored catatan\.txt/);
    assert.equal(tui.child.exitCode, null, 'the TUI must stay alive');
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: /undo turn reverts every file one turn wrote', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-undo-turn-', {
    // Unattended writes keep this test on the undo path: approving two dialogs
    // by hand would only exercise the approval dialog again.
    permissions: { shell: 'ask', fileWrite: 'auto', sensitiveRead: 'ask' },
    toolCalls: [
      { name: 'create_file', arguments: { path: 'satu.txt', content: 'satu\n' } },
      { name: 'create_file', arguments: { path: 'dua.txt', content: 'dua\n' } },
    ],
  });
  const first = path.join(tui.fixtureDir.workspace, 'satu.txt');
  const second = path.join(tui.fixtureDir.workspace, 'dua.txt');
  try {
    await sleep(400);
    tui.write('buat dua file');
    await sleep(300);
    tui.write('\r');
    assert.ok(
      await waitFor(() => fs.existsSync(first) && fs.existsSync(second)),
      `the turn did not write both files:\n${tui.output.slice(-2000)}`,
    );
    assert.ok(await waitFor(() => /Completed in/.test(tui.output)), 'the turn never finished');

    tui.write('/undo turn');
    await sleep(300);
    tui.write('\r');
    assert.ok(
      await waitFor(() => !fs.existsSync(first) && !fs.existsSync(second)),
      `the whole turn was not reverted:\n${tui.output.slice(-2000)}`,
    );
    assert.ok(/Undid the last turn/.test(tui.output), `the notice is missing:\n${tui.output.slice(-1200)}`);
    assert.ok(/2 removed/.test(tui.output), 'the notice must count both files');
    assert.ok(/reverted the last turn/.test(tui.output), 'the transcript must record the rollback');
    assert.equal(tui.child.exitCode, null, 'the TUI must stay alive');
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: a resumed turn that never got an answer is flagged and /continue finishes it', { skip: !HAS_SCRIPT }, async () => {
  const server = await startMockServer();
  const fixtureDir = fixture('mikuhost-pty-continue-', server.url);
  const dbFile = path.join(fixtureDir.configDir, 'sessions.db');
  const store = openSessionStore({ file: dbFile });
  const seeded = store.createSession({
    title: 'Turn terputus',
    model: 'z-ai/glm-5.3-flash',
    workspace: fixtureDir.workspace,
  });
  store.appendMessage(seeded.id, { role: 'user', content: 'Lanjutkan perbaikan reconnect' });
  store.close();
  const tui = launch(fixtureDir, ['--session', seeded.id]);
  try {
    assert.ok(
      await waitFor(() => /The last turn did not finish/.test(tui.output)),
      `the unfinished turn was not reported:\n${tui.output.slice(-2000)}`,
    );
    assert.match(tui.output, /\/continue to resume/);

    tui.write('/continue');
    await sleep(300);
    tui.write('\r');
    assert.ok(await waitFor(() => /Completed in/.test(tui.output)), 'the resumed turn never finished');

    const request = server.requests.at(-1);
    const userMessages = request.messages.filter((message) => message.role === 'user');
    assert.equal(userMessages.length, 1, 'the prompt is not sent twice');
    assert.equal(userMessages[0].content, 'Lanjutkan perbaikan reconnect');

    const check = openSessionStore({ file: dbFile });
    const messages = check.getMessages(seeded.id);
    check.close();
    assert.deepEqual(
      messages.map((message) => message.role),
      ['user', 'assistant'],
      'the resumed answer is appended, the prompt is not duplicated',
    );
    assert.equal(tui.child.exitCode, null);
  } finally {
    await tui.stop();
    await server.close();
  }
});

test('pty: /undo and /continue explain themselves when there is nothing to do', { skip: !HAS_SCRIPT }, async () => {
  const { tui, server } = await startPty('mikuhost-pty-nothing-');
  try {
    await sleep(400);
    tui.write('/undo list');
    await sleep(250);
    tui.write('\r');
    assert.ok(
      await waitFor(() => /Nothing to undo in this session/.test(tui.output)),
      `undo did not report an empty stack:\n${tui.output.slice(-2000)}`,
    );

    tui.write('/continue');
    await sleep(250);
    tui.write('\r');
    assert.ok(
      await waitFor(() => /No unfinished turn to continue/.test(tui.output)),
      `continue did not report a finished conversation:\n${tui.output.slice(-2000)}`,
    );
    assert.equal(tui.child.exitCode, null);
  } finally {
    await tui.stop();
    await server.close();
  }
});
