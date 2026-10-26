// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PROVIDERS,
  createProvider,
  credentialsFromEnv,
  detectProviderFromKey,
  detectedEnvProvider,
  getProvider,
  providerName,
  resolveProviderId,
} from '../src/providers/catalog.mjs';
import { CredentialManager } from '../src/credentials/manager.mjs';
import { validateKeyFormat } from '../src/credentials/storage.mjs';
import { ConfigManager, DEFAULT_CONFIG } from '../src/config/manager.mjs';
import { ModelRegistry, BUILTIN_MODELS } from '../src/models/registry.mjs';
import { AgentRuntime } from '../src/core/agent.mjs';
import { paths } from '../src/config/paths.mjs';
import { tempDir, cleanupDir, setConfigDir, readJson, makeConfigStub, startMockServer, sendJson } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'mikuhost.mjs');

const TOKENHARBOR_BASE_URL_DEFAULT = 'https://tokenharbor.ai/v1';
const NVIDIA_KEY = 'nvapi-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKENHARBOR_KEY = 'thk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function withoutProviderEnv(fn) {
  const names = ['NVIDIA_API_KEY', 'TOKENHARBOR_API_KEY', 'MIKUHOST_API_KEY', 'MIKUHOST_BASE_URL', 'TOKENHARBOR_BASE_URL', 'TOKENHARBOR_MODEL', 'NVIDIA_BASE_URL'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    return fn();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test('providers: token prefix selects the provider', () => {
  assert.equal(detectProviderFromKey(NVIDIA_KEY), 'nvidia');
  assert.equal(detectProviderFromKey(TOKENHARBOR_KEY), 'tokenharbor');
  assert.equal(detectProviderFromKey('thk-cccccccccccccccccccccccc'), 'tokenharbor');
  assert.equal(detectProviderFromKey('unknown-format-token-1234567890'), null);
  assert.equal(detectProviderFromKey(''), null);
  assert.equal(resolveProviderId('TokenHarbor'), 'tokenharbor');
  assert.equal(resolveProviderId('nope'), 'nvidia');
  assert.equal(providerName('tokenharbor'), 'TokenHarbor');
  assert.equal(getProvider('nope'), null);
  assert.equal(PROVIDERS.tokenharbor.baseUrl, 'https://tokenharbor.ai/v1');
});

test('providers: base URL resolution honours provider env overrides', () => {
  withoutProviderEnv(() => {
    const nvidia = createProvider({ provider: 'nvidia', apiKey: NVIDIA_KEY });
    assert.equal(nvidia.baseUrl, 'https://integrate.api.nvidia.com/v1');

    const tokenharbor = createProvider({ provider: 'tokenharbor', apiKey: TOKENHARBOR_KEY });
    assert.equal(tokenharbor.baseUrl, 'https://tokenharbor.ai/v1');

    // Per-provider override beats the global one.
    assert.equal(
      createProvider({
        provider: 'tokenharbor',
        apiKey: TOKENHARBOR_KEY,
        env: { TOKENHARBOR_BASE_URL: 'https://proxy.internal/v1/', MIKUHOST_BASE_URL: 'https://global/v1' },
      }).baseUrl,
      'https://proxy.internal/v1',
    );
    assert.equal(
      createProvider({ provider: 'nvidia', apiKey: NVIDIA_KEY, env: { MIKUHOST_BASE_URL: 'https://global/v1' } }).baseUrl,
      'https://global/v1',
    );
  });
});

test('providers: environment tokens are detected per provider', () => {
  const both = credentialsFromEnv({ NVIDIA_API_KEY: NVIDIA_KEY, TOKENHARBOR_API_KEY: TOKENHARBOR_KEY });
  assert.deepEqual(both.map((entry) => entry.provider), ['nvidia', 'tokenharbor']);
  assert.equal(detectedEnvProvider({ TOKENHARBOR_API_KEY: TOKENHARBOR_KEY }), 'tokenharbor');

  const overridden = credentialsFromEnv({
    TOKENHARBOR_API_KEY: `  ${TOKENHARBOR_KEY}\n`,
    TOKENHARBOR_BASE_URL: 'https://proxy.internal/v1',
    TOKENHARBOR_MODEL: 'qwen3.8-flash:free',
  });
  assert.deepEqual(overridden[0], {
    provider: 'tokenharbor',
    key: TOKENHARBOR_KEY,
    baseUrl: 'https://proxy.internal/v1',
    model: 'qwen3.8-flash:free',
  });

  // Custom gateways need a base URL before the token means anything.
  assert.deepEqual(credentialsFromEnv({ MIKUHOST_API_KEY: 'custom-token-1234567890' }), []);
  assert.equal(
    credentialsFromEnv({ MIKUHOST_API_KEY: 'custom-token-1234567890', MIKUHOST_BASE_URL: 'https://gateway/v1' })[0].provider,
    'custom',
  );
  assert.deepEqual(credentialsFromEnv({ NVIDIA_API_KEY: '   ' }), []);
});

test('credentials: provider is detected on add and stored with the key', () => {
  const dir = setConfigDir(tempDir('mikuhost-provider-add-'));
  try {
    const manager = new CredentialManager({ env: {} });
    const personal = manager.add({ name: 'Personal', key: NVIDIA_KEY });
    const harbor = manager.add({ name: 'Harbor', key: TOKENHARBOR_KEY });
    assert.equal(personal.provider, 'nvidia');
    assert.equal(harbor.provider, 'tokenharbor');
    assert.equal(harbor.providerName, 'TokenHarbor');

    const stored = readJson(paths.credentials());
    assert.equal(stored.keys.length, 2);
    assert.equal(stored.keys[1].provider, 'tokenharbor');

    // An explicit provider wins, and a mismatched prefix only warns.
    assert.equal(validateKeyFormat(NVIDIA_KEY, { provider: 'tokenharbor' }).warning !== null, true);
    assert.equal(validateKeyFormat(TOKENHARBOR_KEY).warning, null);
    assert.equal(manager.add({ name: 'Forced', key: 'plain-token-abcdefghijklmnop', provider: 'custom' }).provider, 'custom');
    assert.equal(manager.firstForProvider('tokenharbor').name, 'Harbor');
    assert.equal(manager.firstForProvider('tokenharbor').id, harbor.id);
  } finally {
    cleanupDir(dir);
  }
});

test('credentials: env tokens are usable, read-only and never written to disk', () => {
  const dir = setConfigDir(tempDir('mikuhost-provider-env-'));
  try {
    const env = { TOKENHARBOR_API_KEY: TOKENHARBOR_KEY, TOKENHARBOR_MODEL: 'deepseek-v4.1-flash:free' };
    const manager = new CredentialManager({ env });
    assert.equal(manager.size, 1);
    assert.equal(manager.activeProvider, 'tokenharbor');
    assert.equal(manager.activeKey(), TOKENHARBOR_KEY);
    assert.equal(manager.activeEntry().source, 'env');
    assert.equal(manager.list()[0].source, 'env');

    // Using the env key does not create a credentials file.
    manager.touch(manager.activeId);
    assert.equal(fs.existsSync(paths.credentials()), false);

    const stored = manager.add({ name: 'Personal', key: NVIDIA_KEY });
    assert.equal(manager.size, 2);
    const onDisk = readJson(paths.credentials());
    assert.equal(onDisk.keys.length, 1, 'only the stored key is persisted');
    assert.equal(onDisk.keys[0].key, NVIDIA_KEY);
    assert.equal(JSON.stringify(onDisk).includes(TOKENHARBOR_KEY), false);

    // Env entries cannot be renamed or deleted from the key manager.
    const envId = `env:tokenharbor`;
    assert.throws(() => manager.remove(envId), /environment/i);
    assert.throws(() => manager.rename(envId, 'nope'), /environment/i);

    // Switching back to a stored key works, and the env key stays available.
    manager.setActive(stored.id);
    assert.equal(manager.activeProvider, 'nvidia');
    assert.equal(manager.firstForProvider('tokenharbor').key, TOKENHARBOR_KEY);

    // Reloading without the variable drops the env entry entirely.
    const reloaded = new CredentialManager({ env: {} });
    assert.equal(reloaded.size, 1);
    assert.equal(reloaded.activeProvider, 'nvidia');
  } finally {
    cleanupDir(dir);
  }
});

test('config: providers exist by default and base URLs follow env overrides', () => {
  const dir = setConfigDir(tempDir('mikuhost-provider-config-'));
  try {
    withoutProviderEnv(() => {
      const config = new ConfigManager();
      const initial = config.load();
      assert.equal(initial.provider, 'nvidia');
      for (const id of ['nvidia', 'tokenharbor', 'custom']) {
        assert.equal(typeof initial.providers[id], 'object', `${id} defaults must exist`);
      }
      assert.equal(initial.providers.tokenharbor.baseUrl, TOKENHARBOR_BASE_URL_DEFAULT);
      assert.equal(config.baseUrlFor('tokenharbor'), TOKENHARBOR_BASE_URL_DEFAULT);
      assert.equal(config.baseUrl, PROVIDERS.nvidia.baseUrl);
      assert.equal(DEFAULT_CONFIG.providers.nvidia.baseUrl, PROVIDERS.nvidia.baseUrl);

      config.setProvider('tokenharbor');
      assert.equal(config.providerId, 'tokenharbor');
      assert.equal(config.get().defaultModel, 'deepseek-v4.1-flash:free');
      const reloaded = new ConfigManager().load();
      assert.equal(reloaded.provider, 'tokenharbor');

      process.env.TOKENHARBOR_BASE_URL = 'https://proxy.internal/v1/';
      assert.equal(config.baseUrlFor('tokenharbor'), 'https://proxy.internal/v1');
      delete process.env.TOKENHARBOR_BASE_URL;
      process.env.MIKUHOST_BASE_URL = 'https://global/v1';
      assert.equal(config.baseUrlFor('nvidia'), 'https://global/v1');
    });
  } finally {
    cleanupDir(dir);
  }
});

test('models: each provider has its own model list and default', () => {
  withoutProviderEnv(() => {
    const registry = new ModelRegistry({ env: {} });
    const harbor = registry.forProvider('tokenharbor');
    assert.equal(harbor.length, 1);
    assert.equal(harbor[0].id, 'deepseek-v4.1-flash:free');
    assert.equal(registry.defaultFor('tokenharbor').id, 'deepseek-v4.1-flash:free');
    assert.equal(registry.defaultFor('nvidia').id, 'z-ai/glm-5.3-flash');
    assert.equal(registry.forProvider('custom').length, 0);
    assert.equal(registry.defaultFor('custom'), null);
    assert.equal(BUILTIN_MODELS.every((model) => model.provider), true);

    const overridden = new ModelRegistry({ env: { TOKENHARBOR_MODEL: 'qwen3.8-flash:free' } });
    assert.equal(overridden.defaultFor('tokenharbor').id, 'qwen3.8-flash:free');

    // A catalogue check only re-marks the provider it belongs to.
    registry.applyCatalogue(['deepseek-v4.1-flash:free'], { provider: 'tokenharbor' });
    assert.equal(registry.status('deepseek-v4.1-flash:free').status, 'available');
    assert.equal(registry.status('z-ai/glm-5.3-flash').status, 'unknown');
  });
});

test('runtime: a TokenHarbor key uses its own model and provider', () => {
  const config = makeConfigStub({ defaultModel: 'z-ai/glm-5.3-flash' });
  const runtime = new AgentRuntime({
    config,
    workspace: { root: '/tmp', focusedPath: null },
    credentials: {
      activeEntry: () => ({ id: 'env:tokenharbor', name: 'TokenHarbor (env)', provider: 'tokenharbor', key: TOKENHARBOR_KEY }),
      activeProvider: 'tokenharbor',
      touch: () => {},
      reportFailure: () => {},
    },
    session: { session: { model: 'z-ai/glm-5.3-flash' }, messages: [] },
  });
  assert.equal(runtime.providerId, 'tokenharbor');
  assert.equal(runtime.providerName, 'TokenHarbor');
  // The NVIDIA model from the old session is replaced by the provider default.
  assert.equal(runtime.activeModel, 'deepseek-v4.1-flash:free');
  // With no NVIDIA key stored there is nothing to switch to.
  assert.throws(() => runtime.setModel('z-ai/glm-5.3-flash'), /no NVIDIA key is stored/);
});

test('runtime: picking a model switches to the key of that model provider', () => {
  const config = makeConfigStub({ defaultModel: 'deepseek-v4.1-flash:free', provider: 'tokenharbor' });
  const harbor = { id: 'k-harbor', name: 'Harbor', provider: 'tokenharbor', key: TOKENHARBOR_KEY };
  const nvidia = { id: 'k-nvidia', name: 'Personal', provider: 'nvidia', key: 'nvapi-test-1234567890abcdef' };
  let active = harbor;
  const credentials = {
    activeEntry: () => active,
    get activeProvider() {
      return active.provider;
    },
    firstForProvider: (id) => [harbor, nvidia].find((entry) => entry.provider === id) ?? null,
    setActive: (id) => {
      active = [harbor, nvidia].find((entry) => entry.id === id) ?? active;
      return active;
    },
    touch: () => {},
    reportFailure: () => {},
  };
  const session = {
    session: { model: 'deepseek-v4.1-flash:free' },
    messages: [],
    setModel(model) {
      this.session.model = model;
    },
  };
  const runtime = new AgentRuntime({
    config,
    workspace: { root: '/tmp', focusedPath: null },
    credentials,
    session,
  });
  assert.equal(runtime.providerId, 'tokenharbor');
  assert.equal(runtime.activeModel, 'deepseek-v4.1-flash:free');

  // An NVIDIA model pulls the NVIDIA key in automatically.
  runtime.setModel('z-ai/glm-5.3-flash');
  assert.equal(credentials.activeEntry().id, 'k-nvidia');
  assert.equal(runtime.providerId, 'nvidia');
  assert.equal(runtime.activeModel, 'z-ai/glm-5.3-flash');
  assert.equal(config.get().provider, 'nvidia');
  assert.equal(config.get().defaultModel, 'z-ai/glm-5.3-flash');

  // And the TokenHarbor DeepSeek model pulls the TokenHarbor key back.
  runtime.setModel('deepseek-v4.1-flash:free');
  assert.equal(credentials.activeEntry().id, 'k-harbor');
  assert.equal(runtime.providerId, 'tokenharbor');
  assert.equal(runtime.activeModel, 'deepseek-v4.1-flash:free');
  assert.equal(config.get().provider, 'tokenharbor');
});

test('runtime: each request picks a validated key of the model provider', () => {
  const dir = setConfigDir(tempDir('mikuhost-provider-pick-'));
  const rolls = [0, 0.99];
  try {
    const manager = new CredentialManager();
    const nvOne = manager.add({ name: 'N1', key: NVIDIA_KEY, status: 'ready' });
    const nvTwo = manager.add({
      name: 'N2',
      key: 'nvapi-cccccccccccccccccccccccccccccccc',
      status: 'ready',
    });
    const harbor = manager.add({ name: 'Harbor', key: TOKENHARBOR_KEY, status: 'ready' });
    // Deterministic random so the test can prove both NVIDIA keys are eligible
    // without depending on luck.
    const pick = manager.pickForProvider.bind(manager);
    manager.pickForProvider = (providerId) => pick(providerId, { random: () => rolls.shift() ?? 0 });

    const config = makeConfigStub({ defaultModel: 'z-ai/glm-5.3-flash' });
    const runtime = new AgentRuntime({
      config,
      workspace: { root: '/tmp', focusedPath: null },
      credentials: manager,
      session: { session: { model: 'z-ai/glm-5.3-flash' }, messages: [], setModel() {} },
    });
    assert.equal(runtime.providerId, 'nvidia');
    assert.equal(runtime.credentialFor().id, nvOne.id);
    assert.equal(runtime.credentialFor().id, nvTwo.id);
    // The Token Harbor key is never a candidate for an NVIDIA model.
    assert.equal(runtime.credentialFor('tokenharbor').id, harbor.id);
  } finally {
    cleanupDir(dir);
  }
});

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      NO_COLOR: '1',
      NVIDIA_API_KEY: '',
      TOKENHARBOR_API_KEY: '',
      MIKUHOST_API_KEY: '',
      MIKUHOST_BASE_URL: '',
      TOKENHARBOR_BASE_URL: '',
      ...env,
    },
  });
}

test('cli: providers command lists base URLs, env variables and active provider', () => {
  const dir = tempDir('mikuhost-provider-cli-');
  try {
    const env = { MIKUHOST_CONFIG_DIR: dir };
    const result = runCli(['providers'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PROVIDERS/);
    assert.match(result.stdout, /NVIDIA/);
    assert.match(result.stdout, /TokenHarbor/);
    assert.match(result.stdout, /https:\/\/tokenharbor\.ai\/v1/);
    assert.match(result.stdout, /TOKENHARBOR_API_KEY/);

    const detected = runCli(['providers'], { ...env, TOKENHARBOR_API_KEY: TOKENHARBOR_KEY });
    assert.equal(detected.status, 0, detected.stderr);
    assert.match(detected.stdout, /detected/);
    assert.equal(detected.stdout.includes(TOKENHARBOR_KEY), false, 'the token is never printed');

    const doctor = runCli(['doctor'], { ...env, TOKENHARBOR_API_KEY: TOKENHARBOR_KEY });
    assert.match(doctor.stdout, /Active provider\s+TokenHarbor/);
    assert.match(doctor.stdout, /Tokens from env\s+TokenHarbor/);
    assert.equal(doctor.stdout.includes(TOKENHARBOR_KEY), false);
  } finally {
    cleanupDir(dir);
  }
});

function runCliAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        NO_COLOR: '1',
        NVIDIA_API_KEY: '',
        TOKENHARBOR_API_KEY: '',
        MIKUHOST_API_KEY: '',
        MIKUHOST_BASE_URL: '',
        TOKENHARBOR_BASE_URL: '',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('cli: doctor checks the TokenHarbor base URL and key detected from env', async () => {
  const dir = tempDir('mikuhost-provider-doctor-');
  const server = await startMockServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKENHARBOR_KEY}`) {
      sendJson(res, 401, { error: { message: 'bad key' } });
      return;
    }
    sendJson(res, 200, { data: [{ id: 'deepseek-v4.1-flash:free' }] });
  });
  try {
    const result = await runCliAsync(['doctor'], {
      MIKUHOST_CONFIG_DIR: dir,
      TOKENHARBOR_API_KEY: TOKENHARBOR_KEY,
      TOKENHARBOR_BASE_URL: server.url,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Active provider\s+TokenHarbor/);
    assert.match(result.stdout, new RegExp(`API base URL\\s+${server.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(result.stdout, /Provider connectivity\s+reachable · 1 models/);
    assert.equal(result.stdout.includes(TOKENHARBOR_KEY), false);
  } finally {
    await server.close();
    cleanupDir(dir);
  }
});

test('cli: keys add detects the provider and can be forced with --provider', () => {
  const dir = tempDir('mikuhost-provider-keys-');
  try {
    const env = { MIKUHOST_CONFIG_DIR: dir };
    const added = runCli(['keys', 'add', 'Harbor', TOKENHARBOR_KEY], env);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /TokenHarbor/);
    assert.equal(added.stdout.includes(TOKENHARBOR_KEY), false);

    const list = runCli(['keys'], env);
    assert.match(list.stdout, /TokenHarbor/);
    assert.match(list.stdout, /thk_••••/);

    const use = runCli(['keys', 'use', 'Harbor'], env);
    assert.match(use.stdout, /TokenHarbor/);

    const forced = runCli(['keys', 'add', 'Gateway', 'plain-token-abcdefghijklmnop', '--provider', 'custom'], env);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, /Custom/);

    const bad = runCli(['keys', 'add', 'Nope', TOKENHARBOR_KEY + 'x', '--provider', 'unknown'], env);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Unknown provider/);
  } finally {
    cleanupDir(dir);
  }
});
