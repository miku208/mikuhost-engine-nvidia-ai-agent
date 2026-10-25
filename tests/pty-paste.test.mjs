import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

async function startMockServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        requests.push(JSON.parse(body));
      } catch {
        requests.push(null);
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
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
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function fixture(prefix, baseUrl) {
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
      providers: { nvidia: { baseUrl } },
      defaultModel: 'z-ai/glm-5.3-flash',
      permissions: { shell: 'ask', fileWrite: 'ask', sensitiveRead: 'ask' },
      ui: { mouse: false },
    }),
  );
  fs.writeFileSync(
    path.join(configDir, 'credentials.json'),
    JSON.stringify({
      version: 1,
      activeId: 'k1',
      keys: [{ id: 'k1', name: 'PTY', key: 'nvapi-pty-test-1234567890abcdef', createdAt: 1, status: 'ready' }],
    }),
  );
  return { root, configDir, workspace };
}

/** Run the real TUI inside a PTY via util-linux `script`, which forwards stdin. */
function launch(fixtureDir) {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, 'bin', 'mikuhost.mjs'))} --workspace ${JSON.stringify(fixtureDir.workspace)}`;
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

async function startPty(prefix) {
  const server = await startMockServer();
  const fixtureDir = fixture(prefix, server.url);
  const tui = launch(fixtureDir);
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
