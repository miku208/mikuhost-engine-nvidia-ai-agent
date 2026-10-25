import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { InputController } from '../src/ui/input-controller.mjs';

const START = '\u001b[200~';
const END = '\u001b[201~';
const CONTENT = "const handler = async (event) => {\n  return event?.id ?? null;\n};\n";

function harness() {
  const stdin = new PassThrough();
  const controller = new InputController({ stdin, holdMs: 10 });
  let filtered = '';
  controller.input.on('data', (chunk) => {
    filtered += chunk.toString('utf8');
  });
  const pastes = [];
  controller.onPaste((content) => pastes.push(content));
  controller.start();
  return {
    stdin,
    controller,
    pastes,
    get filtered() {
      return filtered;
    },
    close() {
      controller.stop();
      stdin.destroy();
      controller.input.destroy();
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('input controller: bracketed markers split per byte stay one paste', async () => {
  const h = harness();
  try {
    h.stdin.write('Cek kode ini ');
    for (const char of `${START}${CONTENT}${END}`) {
      h.stdin.write(char);
      await sleep(1);
    }
    await sleep(20);

    assert.deepEqual(h.pastes, [CONTENT]);
    assert.equal(h.filtered, 'Cek kode ini ', 'no pasted byte may reach the composer stream');
  } finally {
    h.close();
  }
});

test('input controller: long gaps inside a paste never finalize it early', async () => {
  const h = harness();
  try {
    h.stdin.write('Prompt ');
    h.stdin.write(START);
    const chunks = CONTENT.match(/[\s\S]{1,9}/g);
    for (const chunk of chunks) {
      h.stdin.write(chunk);
      await sleep(25);
    }
    assert.equal(h.pastes.length, 0, 'content must still be buffered');
    h.stdin.write(END);
    await sleep(20);
    assert.deepEqual(h.pastes, [CONTENT]);
    assert.equal(h.filtered, 'Prompt ');
  } finally {
    h.close();
  }
});

test('input controller: two consecutive pastes are two exact blocks', async () => {
  const h = harness();
  try {
    const first = 'const a = 1;\n';
    const second = 'const b = 2;\u001b[31m // red\u001b[0m\n';
    h.stdin.write(`${START}${first}${END}${START}${second}${END}`);
    await sleep(20);
    assert.deepEqual(h.pastes, [first, second]);
    assert.equal(h.filtered, '');
  } finally {
    h.close();
  }
});

test('input controller: a plain keystroke and a lone bracket still reach Ink', async () => {
  const h = harness();
  try {
    h.stdin.write('a');
    h.stdin.write('[');
    h.stdin.write('b');
    await sleep(20);
    assert.equal(h.pastes.length, 0);
    assert.equal(h.filtered, 'a[b');
  } finally {
    h.close();
  }
});

test('input controller: an incomplete paste is never published or typed', async () => {
  const h = harness();
  try {
    h.stdin.write(`${START}${CONTENT}`);
    await sleep(30);
    assert.equal(h.pastes.length, 0);
    assert.equal(h.filtered, '');
  } finally {
    h.close();
  }
});
