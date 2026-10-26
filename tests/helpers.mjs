// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

export function tempDir(prefix = 'mikuhost-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function setConfigDir(dir) {
  process.env.MIKUHOST_CONFIG_DIR = dir;
  return dir;
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Start an HTTP server; handler receives (req, res, { body, json, url }). */
export async function startMockServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let json = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {
        json = null;
      }
      requests.push({ method: req.method, url: req.url, body, json, headers: req.headers });
      Promise.resolve(handler(req, res, { body, json, url: req.url, requests })).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message } }));
        }
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
}

export function sendSse(res, events, { usage = null } = {}) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  if (usage) {
    res.write(`data: ${JSON.stringify({ usage, choices: [] })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/** Config manager stub with live get() semantics used by tools/runtime. */
export function makeConfigStub(overrides = {}) {
  const state = {
    permissions: { shell: 'ask', fileWrite: 'ask', sensitiveRead: 'ask', ...(overrides.permissions ?? {}) },
    agent: { maxIterations: 20, commandTimeoutMs: 5000, compactAfterMessages: 80, ...(overrides.agent ?? {}) },
    ui: { streaming: true, showActivity: true, mouse: false, ...(overrides.ui ?? {}) },
    models: [],
    defaultModel: 'z-ai/glm-5.3-flash',
    workspace: null,
    ...overrides,
  };
  state.permissions = { shell: 'ask', fileWrite: 'ask', sensitiveRead: 'ask', ...(overrides.permissions ?? {}) };
  state.agent = { maxIterations: 0, commandTimeoutMs: 5000, compactAfterMessages: 80, ...(overrides.agent ?? {}) };
  state.ui = { streaming: true, showActivity: true, mouse: false, ...(overrides.ui ?? {}) };
  return {
    state,
    get() {
      return state;
    },
    setValue(dotted, value) {
      const parts = dotted.split('.');
      let cursor = state;
      for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
      cursor[parts.at(-1)] = value;
    },
    update(patch) {
      Object.assign(state, patch);
    },
    get baseUrl() {
      return overrides.baseUrl ?? 'http://127.0.0.1:1/v1';
    },
    get permissionMode() {
      return state.permissions.shell;
    },
    get workspaceSetting() {
      return state.workspace;
    },
  };
}

export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

export function workspaceFixture() {
  const root = tempDir('mikuhost-ws-');
  fs.mkdirSync(path.join(root, 'project', 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'project', 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'project', 'package.json'),
    JSON.stringify({ name: 'ourin', dependencies: { baileys: '^6.7.0' }, scripts: { test: 'node test.js' } }, null, 2),
  );
  fs.writeFileSync(path.join(root, 'project', 'src', 'index.js'), "const express = require('express');\n// connection.update handler\n");
  fs.writeFileSync(path.join(root, 'project', 'node_modules', 'dep', 'index.js'), 'ignored');
  fs.writeFileSync(path.join(root, 'project', '.env'), 'SECRET_TOKEN=nvapi-should-not-leak-1234567890\n');
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });
  fs.writeFileSync(path.join(root, 'other', 'server.js'), 'server');
  return root;
}

export async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}
