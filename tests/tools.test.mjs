import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ToolRegistry } from '../src/tools/registry.mjs';
import { validateSchema } from '../src/tools/schema.mjs';
import { Workspace } from '../src/security/workspace.mjs';
import { makeConfigStub, workspaceFixture, tempDir, cleanupDir } from './helpers.mjs';

function setup({ permissions = {}, approve = true, root = null } = {}) {
  const workspaceRoot = root ?? workspaceFixture();
  const config = makeConfigStub({ permissions });
  const approvals = [];
  const ws = new Workspace(workspaceRoot);
  const registry = new ToolRegistry({
    workspace: ws,
    config,
    requestApproval: async (request) => {
      approvals.push(request);
      return typeof approve === 'function' ? approve(request) : approve;
    },
    onActivity: () => {},
  });
  return { registry, workspaceRoot, approvals, ws, config };
}

test('tools: registry exposes the full tool set with valid schemas', () => {
  const { registry } = setup();
  const definitions = registry.definitions();
  const names = definitions.map((definition) => definition.function.name).sort();
  assert.deepEqual(names, [
    'create_file',
    'edit_file',
    'file_info',
    'list_directory',
    'read_file',
    'run_command',
    'search_files',
    'search_text',
    'write_file',
  ]);
  for (const definition of definitions) {
    assert.equal(definition.type, 'function');
    assert.equal(definition.function.parameters.type, 'object');
    assert.ok(definition.function.description.length > 20);
  }
});

test('tools: schema validator enforces required fields and unknown keys', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2 },
      count: { type: 'integer', minimum: 1, maximum: 5 },
      flag: { type: 'boolean' },
    },
    required: ['name'],
    additionalProperties: false,
  };
  assert.deepEqual(validateSchema(schema, { name: 'ok' }), []);
  assert.equal(validateSchema(schema, {}).length, 1);
  assert.equal(validateSchema(schema, { name: 'x' }).length, 1);
  assert.equal(validateSchema(schema, { name: 'ok', count: 9 }).length, 1);
  assert.equal(validateSchema(schema, { name: 'ok', count: 1.5 }).length, 1);
  assert.equal(validateSchema(schema, { name: 'ok', extra: true }).length, 1);
});

test('tools: unknown tools and invalid input return structured errors', async () => {
  const { registry } = setup();
  const unknown = await registry.execute('nope', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.errorCode, 'UNKNOWN_TOOL');

  const missing = await registry.execute('read_file', {});
  assert.equal(missing.ok, false);
  assert.equal(missing.errorCode, 'INVALID_TOOL_INPUT');
  assert.match(missing.error, /path is required/);

  const extra = await registry.execute('read_file', { path: 'project/package.json', nope: 1 });
  assert.equal(extra.ok, false);
  assert.equal(extra.errorCode, 'INVALID_TOOL_INPUT');
});

test('tools: read_file works without approval for normal files', async () => {
  const { registry, approvals } = setup();
  const result = await registry.execute('read_file', { path: 'project/package.json' });
  assert.equal(result.ok, true);
  assert.match(result.output, /<file path="project\/package.json"/);
  assert.match(result.output, /"name": "ourin"/);
  assert.equal(approvals.length, 0);
});

test('tools: sensitive reads require approval and can be denied', async () => {
  const approveRun = setup();
  const result = await approveRun.registry.execute('read_file', { path: 'project/.env' });
  assert.equal(result.ok, true);
  assert.equal(approveRun.approvals.length, 1);
  assert.equal(approveRun.approvals[0].kind, 'file-read');
  assert.equal(approveRun.approvals[0].sensitive, true);
  assert.match(result.output, /SECRET_TOKEN/);

  const denyRun = setup({ approve: false });
  const denied = await denyRun.registry.execute('read_file', { path: 'project/.env' });
  assert.equal(denied.ok, false);
  assert.equal(denied.errorCode, 'PERMISSION_DENIED');

  const allowSensitive = setup({ permissions: { sensitiveRead: 'allow' } });
  const automatic = await allowSensitive.registry.execute('read_file', { path: 'project/.env' });
  assert.equal(automatic.ok, true);
  assert.equal(allowSensitive.approvals.length, 0);
});

test('tools: path escapes are rejected for every file tool', async () => {
  const { registry } = setup();
  for (const [tool, input] of [
    ['read_file', { path: '../../../etc/passwd' }],
    ['list_directory', { path: '/' }],
    ['file_info', { path: '/etc/hosts' }],
    ['write_file', { path: '../escaped.txt', content: 'x' }],
    ['create_file', { path: '/tmp/escaped.txt', content: 'x' }],
    ['edit_file', { path: '../../etc/hosts', old_string: 'a', new_string: 'b' }],
    ['search_files', { pattern: '*', path: '..' }],
  ]) {
    const result = await registry.execute(tool, input);
    assert.equal(result.ok, false, `${tool} should reject`);
    assert.match(result.error, /escapes the workspace|no such file/i, tool);
  }
});

test('tools: list_directory skips dependencies and hidden dirs', async () => {
  const { registry } = setup();
  const result = await registry.execute('list_directory', { path: 'project', depth: 2 });
  assert.equal(result.ok, true);
  assert.match(result.output, /src\//);
  assert.match(result.output, /package\.json/);
  assert.equal(result.output.includes('node_modules'), false);
  assert.equal(result.output.includes('.env'), false);
});

test('tools: search_files and search_text find project content', async () => {
  const { registry } = setup();
  const files = await registry.execute('search_files', { pattern: '*.js', path: 'project' });
  assert.equal(files.ok, true);
  assert.match(files.output, /project\/src\/index\.js/);
  assert.equal(files.output.includes('node_modules'), false);

  const text = await registry.execute('search_text', { query: 'connection.update', path: 'project' });
  assert.equal(text.ok, true);
  assert.match(text.output, /project\/src\/index\.js:2/);

  const regex = await registry.execute('search_text', { query: 'require\\(', path: 'project', regex: true });
  assert.equal(regex.ok, true);
  assert.match(regex.output, /index\.js/);

  const none = await registry.execute('search_text', { query: 'zzz-not-here', path: 'project' });
  assert.equal(none.ok, true);
  assert.match(none.output, /No matches found/);

  const invalid = await registry.execute('search_text', { query: '(', path: 'project', regex: true });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errorCode, 'INVALID_REGEX');

  const envSecret = await registry.execute('search_text', { query: 'SECRET_TOKEN', path: 'project' });
  assert.equal(envSecret.ok, true);
  assert.equal(envSecret.output.includes('SECRET_TOKEN=nvapi'), false);
});

test('tools: file_info reports metadata', async () => {
  const { registry } = setup();
  const result = await registry.execute('file_info', { path: 'project/src/index.js' });
  assert.equal(result.ok, true);
  assert.match(result.output, /type: file/);
  assert.match(result.output, /language: javascript/);
  assert.match(result.output, /sensitive: false/);
});

test('tools: write_file and create_file require approval and write the file', async () => {
  const { registry, approvals, workspaceRoot } = setup();
  const created = await registry.execute('create_file', { path: 'project/new/note.txt', content: 'hello world' });
  assert.equal(created.ok, true);
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'project/new/note.txt'), 'utf8'), 'hello world');
  assert.equal(approvals[0].kind, 'file-create');

  const overwritten = await registry.execute('write_file', {
    path: 'project/new/note.txt',
    content: 'hello again',
  });
  assert.equal(overwritten.ok, true);
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'project/new/note.txt'), 'utf8'), 'hello again');
  const writeRequest = approvals.find((request) => request.kind === 'file-write');
  assert.ok(writeRequest);
  assert.match(writeRequest.diff, /hello again/);

  const existing = await registry.execute('create_file', { path: 'project/new/note.txt', content: 'x' });
  assert.equal(existing.ok, false);
  assert.equal(existing.errorCode, 'ALREADY_EXISTS');
});

test('tools: denied writes leave the file untouched', async () => {
  const { registry, workspaceRoot } = setup({ approve: false });
  const before = fs.readFileSync(path.join(workspaceRoot, 'project/src/index.js'), 'utf8');
  const result = await registry.execute('write_file', { path: 'project/src/index.js', content: 'hacked' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'PERMISSION_DENIED');
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'project/src/index.js'), 'utf8'), before);
});

test('tools: sensitive writes always require approval even when fileWrite is allow', async () => {
  const { registry, approvals } = setup({ permissions: { fileWrite: 'allow' } });
  const result = await registry.execute('write_file', { path: 'project/.env', content: 'TOKEN=x\n' });
  assert.equal(result.ok, true);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].kind, 'file-write');
  assert.equal(approvals[0].sensitive, true);
});

test('tools: edit_file enforces unique matches', async () => {
  const { registry, workspaceRoot } = setup();
  const result = await registry.execute('edit_file', {
    path: 'project/src/index.js',
    old_string: "require('express')",
    new_string: "require('fastify')",
  });
  assert.equal(result.ok, true);
  assert.match(fs.readFileSync(path.join(workspaceRoot, 'project/src/index.js'), 'utf8'), /fastify/);

  const missing = await registry.execute('edit_file', {
    path: 'project/src/index.js',
    old_string: 'not present anywhere',
    new_string: 'x',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.errorCode, 'NOT_FOUND');

  fs.writeFileSync(path.join(workspaceRoot, 'project/dup.txt'), 'same\nsame\n');
  const ambiguous = await registry.execute('edit_file', {
    path: 'project/dup.txt',
    old_string: 'same',
    new_string: 'other',
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.errorCode, 'AMBIGUOUS_MATCH');

  const all = await registry.execute('edit_file', {
    path: 'project/dup.txt',
    old_string: 'same',
    new_string: 'other',
    replace_all: true,
  });
  assert.equal(all.ok, true);
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'project/dup.txt'), 'utf8'), 'other\nother\n');
});

test('tools: read limits protect against oversized files', async () => {
  const root = tempDir('mikuhost-bigfile-');
  try {
    fs.writeFileSync(path.join(root, 'big.txt'), 'a'.repeat(600 * 1024));
    const { registry } = setup({ root });
    const result = await registry.execute('read_file', { path: 'big.txt' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'TOO_LARGE');
  } finally {
    cleanupDir(root);
  }
});

test('tools: run_command asks in ask mode, runs and reports output', async () => {
  const { registry, approvals } = setup();
  const result = await registry.execute('run_command', { command: 'echo hello-tool' });
  assert.equal(result.ok, true);
  assert.match(result.output, /hello-tool/);
  assert.equal(result.meta.exitCode, 0);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].kind, 'command');
  assert.equal(approvals[0].mode, 'ask');
});

test('tools: run_command denial prevents execution', async () => {
  const { registry, workspaceRoot } = setup({ approve: false });
  const result = await registry.execute('run_command', { command: 'touch should-not-exist.txt' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'PERMISSION_DENIED');
  assert.equal(fs.existsSync(path.join(workspaceRoot, 'should-not-exist.txt')), false);
});

test('tools: allow mode auto-runs read-only commands but not destructive ones', async () => {
  const root = workspaceFixture();
  try {
    const readOnly = setup({ root, permissions: { shell: 'allow' } });
    const listing = await readOnly.registry.execute('run_command', { command: 'ls project' });
    assert.equal(listing.ok, true);
    assert.equal(readOnly.approvals.length, 0);

    const destructive = setup({ root, permissions: { shell: 'allow' } });
    const result = await destructive.registry.execute('run_command', { command: 'rm -rf project/node_modules' });
    assert.equal(result.ok, true);
    assert.equal(destructive.approvals.length, 1);
    assert.equal(destructive.approvals[0].risk, 'critical');
    assert.equal(fs.existsSync(path.join(root, 'project/node_modules')), false);
  } finally {
    cleanupDir(root);
  }
});

test('tools: unattended mode runs destructive commands and sensitive writes without approval', async () => {
  const root = workspaceFixture();
  try {
    const unattended = setup({ root, permissions: { shell: 'auto', fileWrite: 'auto', sensitiveRead: 'auto' } });
    const result = await unattended.registry.execute('run_command', { command: 'rm -rf project/node_modules' });
    assert.equal(result.ok, true);
    assert.equal(unattended.approvals.length, 0);
    assert.equal(fs.existsSync(path.join(root, 'project/node_modules')), false);

    const secret = await unattended.registry.execute('read_file', { path: 'project/.env' });
    assert.equal(secret.ok, true);
    const write = await unattended.registry.execute('write_file', { path: 'project/.env', content: 'A=1\n' });
    assert.equal(write.ok, true);
    assert.equal(unattended.approvals.length, 0);
  } finally {
    cleanupDir(root);
  }
});

test('tools: run_command enforces timeouts and kills the process', async () => {
  const { registry } = setup();
  const started = Date.now();
  const result = await registry.execute('run_command', { command: 'sleep 10', timeout_ms: 1000 });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, true);
  assert.equal(result.meta.timedOut, true);
  assert.ok(elapsed < 6000, `timeout took ${elapsed}ms`);
});

test('tools: run_command rejects cwd outside the workspace', async () => {
  const { registry } = setup();
  const result = await registry.execute('run_command', { command: 'ls', cwd: '../..' });
  assert.equal(result.ok, false);
  assert.match(result.error, /escapes the workspace/i);
});
