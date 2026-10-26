import test from 'node:test';
import assert from 'node:assert/strict';
import { NvidiaProvider } from '../src/providers/nvidia.mjs';
import { ProviderError, ERROR_CODES, parseRetryAfter, classifyHttpError } from '../src/providers/errors.mjs';
import { startMockServer, sendJson, sendSse } from './helpers.mjs';

const MODEL = 'z-ai/glm-5.3-flash';
const KEY = 'nvapi-testkey-1234567890abcdef';

async function withServer(handler, run) {
  const server = await startMockServer(handler);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

test('provider: model catalogue and key validation', async () => {
  await withServer(
    (req, res) => {
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        sendJson(res, 401, { error: { message: 'invalid credential' } });
        return;
      }
      sendJson(res, 200, { data: [{ id: MODEL }, { id: 'nvidia/other' }] });
    },
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      const models = await provider.listModels();
      assert.deepEqual(models, [MODEL, 'nvidia/other']);

      const valid = await provider.validateKey(KEY);
      assert.equal(valid.valid, true);
      assert.equal(valid.models.length, 2);

      const invalid = await provider.validateKey('nvapi-wrongkey-000000000000');
      assert.equal(invalid.valid, false);
      assert.equal(invalid.offline, false);
      assert.equal(invalid.error.code, ERROR_CODES.AUTH);
    },
  );
});

test('provider: validation sends a real chat completion, not just /models', async () => {
  await withServer(
    (req, res) => {
      if (req.url.endsWith('/chat/completions')) {
        if (req.headers.authorization !== `Bearer ${KEY}`) {
          sendJson(res, 401, { error: { message: 'invalid credential' } });
          return;
        }
        sendJson(res, 200, { choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }] });
        return;
      }
      // The catalogue is gated independently of chat: a broken /models must not
      // hide a working key, and a working /models must not vouch for a broken one.
      sendJson(res, 401, { error: { message: 'catalogue unavailable' } });
    },
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: 'nvapi-placeholder-000000000' });
      const good = await provider.validateKey(KEY, { model: MODEL });
      assert.equal(good.valid, true);
      assert.equal(good.model, MODEL);
      assert.deepEqual(good.models, []);

      const bad = await provider.validateKey('nvapi-wrongkey-000000000000', { model: MODEL });
      assert.equal(bad.valid, false);
      assert.equal(bad.offline, false);
      assert.equal(bad.error.code, ERROR_CODES.AUTH);

      const chat = server.requests.filter((request) => request.url.endsWith('/chat/completions'));
      assert.equal(chat.length, 2);
      assert.equal(chat[0].json.model, MODEL);
      assert.equal(chat[0].headers.authorization, `Bearer ${KEY}`);
      assert.ok(Array.isArray(chat[0].json.messages));
      assert.equal(chat[0].json.messages[0].role, 'user');
    },
  );
});

test('provider: validation waits for Retry-After and retries a rate-limited key', async () => {
  let attempts = 0;
  await withServer(
    (req, res) => {
      if (!req.url.endsWith('/chat/completions')) {
        sendJson(res, 200, { data: [{ id: MODEL }] });
        return;
      }
      attempts += 1;
      if (attempts === 1) {
        sendJson(res, 429, { error: { message: 'rate limited' } }, { 'Retry-After': '1' });
        return;
      }
      sendJson(res, 200, { choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }] });
    },
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      const waits = [];
      const started = Date.now();
      const result = await provider.validateKey(KEY, {
        model: MODEL,
        onWait: (info) => waits.push(info),
      });
      assert.equal(result.valid, true);
      assert.equal(result.models.length, 1);
      assert.equal(attempts, 2);
      assert.equal(waits.length, 1);
      assert.equal(waits[0].waitMs, 1000);
      assert.ok(
        Date.now() - started >= 900,
        'the retry must actually wait for Retry-After',
      );
    },
  );
});

test('provider: a key that stays rate limited is not marked invalid', async () => {
  await withServer(
    (req, res) => sendJson(res, 429, { error: { message: 'rate limited' } }, { 'Retry-After': '0' }),
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      const result = await provider.validateKey(KEY, { model: MODEL });
      assert.equal(result.valid, false);
      assert.equal(result.rateLimited, true);
      assert.equal(result.error.code, ERROR_CODES.RATE_LIMIT);
    },
  );
});

test('provider: 403 account verification is blocked, not an invalid key', async () => {
  // TokenHarbor answers an unverified account exactly like this on both
  // endpoints; the bearer token was recognised, so the key is not the problem.
  const body = {
    error: {
      message:
        'Verify your email address to use the API. We sent a confirmation link when you signed up — open it, or request a new one at https://tokenharbor.ai/dashboard, then retry this request.',
      type: 'email_verification_required',
      code: 'email_verification_required',
    },
  };
  await withServer(
    (req, res) => sendJson(res, 403, body),
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      const result = await provider.validateKey(KEY, { model: 'deepseek-v4.1-flash:free' });
      assert.equal(result.valid, false);
      assert.equal(result.blocked, true);
      assert.equal(result.accountBlocked, true);
      assert.equal(result.error.code, ERROR_CODES.ACCOUNT);
      assert.equal(result.error.httpStatus, 403);
      assert.match(result.error.message, /Verify your email address/);
      assert.match(result.error.message, /https:\/\/tokenharbor\.ai\/dashboard/);

      const catalogue = classifyHttpError(403, JSON.stringify(body), { get: () => null });
      assert.equal(catalogue.code, ERROR_CODES.ACCOUNT);
    },
  );
});

test('provider: a plain 403 is blocked, never reported as an invalid key', async () => {
  await withServer(
    (req, res) => sendJson(res, 403, { error: { message: 'model not enabled for this key' } }),
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      const result = await provider.validateKey(KEY, { model: MODEL });
      assert.equal(result.valid, false);
      assert.equal(result.blocked, true);
      assert.equal(result.accountBlocked, undefined);
      assert.equal(result.error.code, ERROR_CODES.FORBIDDEN);
    },
  );
});

test('provider: offline validation is reported as offline, not valid or invalid', async () => {
  const provider = new NvidiaProvider({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: KEY, timeoutMs: 2000 });
  const result = await provider.validateKey(KEY);
  assert.equal(result.valid, false);
  assert.equal(result.offline, true);
  assert.equal(result.error.code, ERROR_CODES.NETWORK);
});

test('provider: streams text chunks and usage', async () => {
  await withServer(
    (req, res) => {
      sendSse(
        res,
        [
          { choices: [{ index: 0, delta: { content: 'Hello ' } }] },
          { choices: [{ index: 0, delta: { content: 'world' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ],
        { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      );
    },
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      const events = [];
      for await (const event of provider.streamChat({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] })) {
        events.push(event);
      }
      const text = events.filter((event) => event.type === 'text').map((event) => event.text).join('');
      assert.equal(text, 'Hello world');
      const usage = events.find((event) => event.type === 'usage');
      assert.deepEqual(usage.usage, { promptTokens: 10, completionTokens: 2, totalTokens: 12 });
      const done = events.find((event) => event.type === 'done');
      assert.equal(done.finishReason, 'stop');
      assert.equal(server.requests.length, 1);
      assert.equal(server.requests[0].json.stream, true);
    },
  );
});

test('provider: merges incremental tool call deltas', async () => {
  await withServer(
    (req, res) => {
      sendSse(res, [
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '"package.json"}' } }] },
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ]);
    },
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      const result = await provider.chat({ model: MODEL, messages: [{ role: 'user', content: 'read it' }] });
      assert.equal(result.toolCalls.length, 1);
      assert.equal(result.toolCalls[0].id, 'call_1');
      assert.equal(result.toolCalls[0].function.name, 'read_file');
      assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { path: 'package.json' });
      assert.equal(result.finishReason, 'tool_calls');
    },
  );
});

test('provider: 429 reports retry-after and does not retry automatically', async () => {
  await withServer(
    (req, res) => {
      sendJson(res, 429, { error: { message: 'rate limited' } }, { 'Retry-After': '42' });
    },
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      let error = null;
      try {
        await provider.chat({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, ERROR_CODES.RATE_LIMIT);
      assert.equal(error.httpStatus, 429);
      assert.equal(error.retryAfterMs, 42_000);
      assert.equal(server.requests.length, 1);
    },
  );
});

test('provider: auth and model errors are classified', async () => {
  await withServer(
    (req, res) => {
      if (req.url.endsWith('/models')) {
        sendJson(res, 401, { error: { message: 'bad key nvapi-supersecretkeyvalue' } });
        return;
      }
      sendJson(res, 404, { error: { message: 'model z-ai/glm-5.3-flash not found' } });
    },
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      let authError = null;
      try {
        await provider.listModels();
      } catch (error) {
        authError = error;
      }
      assert.equal(authError.code, ERROR_CODES.AUTH);
      assert.equal(authError.message.includes('nvapi-supersecretkeyvalue'), false);

      let modelError = null;
      try {
        await provider.chat({ model: MODEL, messages: [] });
      } catch (error) {
        modelError = error;
      }
      assert.equal(modelError.code, ERROR_CODES.INVALID_MODEL);
      assert.match(modelError.message, /Model unavailable for this credential/);
    },
  );
});

test('provider: falls back to non-streaming when streaming is rejected', async () => {
  await withServer(
    (req, res, { json }) => {
      if (json?.stream) {
        sendJson(res, 400, { error: { message: 'stream is not supported for this model' } });
        return;
      }
      sendJson(res, 200, {
        choices: [{ message: { content: 'non-streaming answer', tool_calls: [] }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    },
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      const events = [];
      for await (const event of provider.streamChat({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] })) {
        events.push(event);
      }
      assert.equal(
        events.filter((event) => event.type === 'text').map((event) => event.text).join(''),
        'non-streaming answer',
      );
      assert.equal(events.find((event) => event.type === 'transport').streaming, false);
      assert.equal(server.requests.length, 2);
      assert.equal(server.requests[0].json.stream, true);
      assert.equal(server.requests[1].json.stream, false);
    },
  );
});

test('provider: ignores malformed SSE frames instead of crashing', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {not json}\n\n');
      res.write('event: ping\n\n');
      res.write('data: {"choices":[{"delta":{"content":"survived"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      const result = await provider.chat({ model: MODEL, messages: [] });
      assert.equal(result.text, 'survived');
    },
  );
});

test('provider: request timeout is reported as TIMEOUT, not a crash', async () => {
  await withServer(
    () => {
      // Never respond: the provider's own timeout must abort the request.
    },
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY, timeoutMs: 300 });
      await assert.rejects(
        provider.chat({ model: MODEL, messages: [{ role: 'user', content: 'hang' }] }),
        (error) => error.code === ERROR_CODES.TIMEOUT || error.code === ERROR_CODES.NETWORK,
      );
    },
  );
});

test('provider: cancellation aborts the request', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const timer = setInterval(() => res.write(': keepalive\n\n'), 50);
      req.on('close', () => clearInterval(timer));
    },
    async (server) => {
      const provider = new NvidiaProvider({ baseUrl: server.url, apiKey: KEY });
      const controller = new AbortController();
      const started = Date.now();
      const iteration = (async () => {
        for await (const event of provider.streamChat({
          model: MODEL,
          messages: [{ role: 'user', content: 'wait' }],
          signal: controller.signal,
        })) {
          void event;
        }
      })();
      setTimeout(() => controller.abort(), 150);
      await assert.rejects(iteration, (error) => error.code === ERROR_CODES.ABORTED);
      assert.ok(Date.now() - started < 5000);
    },
  );
});

test('provider: retry-after parsing and error classification helpers', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter(null), null);
  assert.ok(parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) > 0);
  const error = classifyHttpError(500, '{"error":{"message":"boom"}}', { get: () => null });
  assert.equal(error.code, ERROR_CODES.SERVER);
  assert.equal(error.retriable, true);
});
