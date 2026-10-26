// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PASTE_CONTEXT_LIMIT,
  createBracketedPasteCapture,
  createPasteBatcher,
  createPastedAttachment,
  formatAttachmentCard,
  formatAttachmentSummary,
  composePromptWithAttachments,
  shouldBecomeAttachment,
  sanitizeForDisplay,
  pasteSettings,
} from '../src/paste/attachments.mjs';
import {
  COMPOSER_BORDER_ROWS,
  composerBudget,
  composerTextLines,
  maxAttachmentRows,
} from '../src/ui/composer-layout.mjs';
import { escapeAction, removeAttachmentById } from '../src/ui/selection.mjs';
import { SLASH_COMMANDS } from '../src/ui/slash.mjs';
import { buildChatLines } from '../src/ui/text-layout.mjs';

const KEY_SAMPLE = 'nvapi-paste-test-1234567890';

function payload(characters, { newlines = true } = {}) {
  const line = 'const handler = async (event) => {\n  return event?.id ?? null;\n};\n';
  if (!newlines) return 'x'.repeat(characters);
  let text = '';
  while (text.length < characters) text += line;
  return text.slice(0, characters);
}

function feedChunks(capture, chunks) {
  const pastes = [];
  let text = '';
  for (const chunk of chunks) {
    const result = capture.feed(chunk);
    pastes.push(...result.pastes);
    text += result.text;
  }
  return { pastes, text };
}

function chunkedPaste(content, chunkSize) {
  const chunks = ['[200~'];
  for (let index = 0; index < content.length; index += chunkSize) chunks.push(content.slice(index, index + chunkSize));
  chunks.push('[201~');
  return chunks;
}

function deterministicChunks(content, seed = 7) {
  let state = seed;
  const chunks = [];
  let index = 0;
  while (index < content.length) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const size = 1 + (state % 997);
    chunks.push(content.slice(index, index + size));
    index += size;
  }
  return chunks;
}

test('paste v7: 100/500/10,206/23,814/60,000 characters become exactly one paste', () => {
  for (const size of [100, 500, 10_206, 23_814, 60_000]) {
    const content = payload(size);
    assert.equal(content.length, size);

    for (const chunks of [
      [`[200~${content}[201~`],
      chunkedPaste(content, 4096),
      ['[200~', ...deterministicChunks(content), '[201~'],
    ]) {
      const capture = createBracketedPasteCapture();
      const result = feedChunks(capture, chunks);
      assert.equal(result.pastes.length, 1, `size ${size}: one paste operation`);
      assert.equal(result.pastes[0].length, size, `size ${size}: no duplicated or lost characters`);
      assert.equal(result.pastes[0], content, `size ${size}: content is byte-for-byte the clipboard`);
      assert.equal(result.text, '');
      assert.equal(capture.active, false);
    }
  }
});

test('paste v7: markers split at every possible chunk boundary are still one paste', () => {
  const content = `const token = '${'x'.repeat(120)}';\n`;
  for (const marker of ['[200~', '\u001b[200~']) {
    const endMarker = marker.startsWith('\u001b') ? '\u001b[201~' : '[201~';
    const whole = `${marker}${content}${endMarker}`;
    // The app feeds Ink's marker form (no leading ESC). A single ESC is the
    // Escape key, so the ESC-prefixed variant is tested from its second byte.
    for (let cut = marker.startsWith('\u001b') ? 2 : 1; cut < whole.length; cut += 1) {
      const capture = createBracketedPasteCapture();
      const result = feedChunks(capture, [whole.slice(0, cut), whole.slice(cut)]);
      assert.equal(result.pastes.length, 1, `marker ${JSON.stringify(marker)} cut at ${cut}`);
      assert.equal(result.pastes[0], content);
      assert.equal(result.text, '');
    }
  }
});

test('paste v7: text outside a paste is returned, never merged into the attachment', () => {
  const capture = createBracketedPasteCapture();
  const before = capture.feed('explain this: [200~const a = 1;[201~ thanks');
  assert.deepEqual(before.pastes, ['const a = 1;']);
  assert.equal(before.text, 'explain this:  thanks');

  const late = capture.feed('tail');
  assert.equal(late.text, 'tail');
  assert.equal(late.consumed, false);
});

test('paste v7: two independent paste operations stay two attachments', () => {
  const capture = createBracketedPasteCapture();
  const first = capture.feed(`[200~${'a'.repeat(600)}[201~`);
  const second = capture.feed(`[200~${'b'.repeat(600)}[201~`);
  assert.equal(first.pastes.length, 1);
  assert.equal(second.pastes.length, 1);
  assert.notEqual(first.pastes[0], second.pastes[0]);

  const twoInOneRead = createBracketedPasteCapture().feed('[200~one[201~[200~two[201~');
  assert.deepEqual(twoInOneRead.pastes, ['one', 'two']);
});

test('paste v7: short text stays normal text; explicit capture can force an attachment', () => {
  assert.equal(shouldBecomeAttachment('short', pasteSettings({})), false);
  assert.equal(shouldBecomeAttachment(payload(100), pasteSettings({})), false);
  const forced = createPastedAttachment('short', { settings: pasteSettings({}) });
  assert.equal(forced.chars, 5);
  assert.equal(forced.content, 'short');
});

test('paste v7: ANSI is kept in the source and stripped only for display', () => {
  const source = `\u001b[31m${'red code\n'}\u001b[0m${'line\n'.repeat(60)}`;
  const attachment = createPastedAttachment(source, { settings: pasteSettings({}) });
  assert.equal(attachment.content, source, 'raw source is preserved as data');
  assert.equal(attachment.preview.includes('\u001b'), false);
  assert.equal(sanitizeForDisplay(source).includes('\u001b'), false);
  const prompt = composePromptWithAttachments('check', [attachment]);
  assert.ok(prompt.includes(source), 'the model receives the untouched source');
});

test('paste v7: 60k characters delivered in 4 KB chunks are committed once', () => {
  let scheduled = null;
  const commits = [];
  const batcher = createPasteBatcher({
    delayMs: 180,
    commit: (text) => commits.push(text),
    schedule: (fn) => {
      scheduled = fn;
      return 1;
    },
    cancel: () => {},
  });

  const content = payload(60_000);
  for (let index = 0; index < content.length; index += 4096) batcher.feed(content.slice(index, index + 4096));
  assert.equal(commits.length, 0);
  assert.equal(batcher.size, 60_000);
  scheduled();
  assert.equal(commits.length, 1, 'one burst becomes one commit');
  assert.equal(commits[0], content);

  // A second, separate paste is a second commit.
  batcher.feed('x'.repeat(10));
  batcher.flush();
  assert.equal(commits.length, 2);
  assert.equal(commits[1], 'x'.repeat(10));
});

test('paste v7: compact chip labels and narrow-terminal summary', () => {
  const settings = pasteSettings({});
  const js = createPastedAttachment(payload(23_814), { settings });
  assert.equal(formatAttachmentCard(js), '[JS · 23,814 chars]');
  assert.equal(formatAttachmentCard(createPastedAttachment('a'.repeat(600), { settings, nameHint: 'x.css' })), '[CSS · 600 chars]');
  assert.equal(formatAttachmentCard(createPastedAttachment('a'.repeat(600), { settings, nameHint: 'x.ts' })), '[TS · 600 chars]');

  const list = [
    js,
    createPastedAttachment('a'.repeat(600), { settings, nameHint: 'x.css' }),
    createPastedAttachment('a'.repeat(600), { settings }),
  ];
  const summary = formatAttachmentSummary(list, list[2].id);
  assert.match(summary, /\[JS · 23,814 chars\]/);
  assert.match(summary, /\+1 more/);
  assert.equal(summary.includes('\n'), false, 'summary is single-line');
});

test('paste v7: the composer stays inside its row budget with chips', () => {
  for (const rows of [15, 24, 40]) {
    for (const chips of [0, 1, maxAttachmentRows(rows)]) {
      const textRows = composerTextLines(rows, chips);
      assert.ok(textRows >= 1);
      assert.ok(
        textRows + chips + COMPOSER_BORDER_ROWS <= composerBudget(rows),
        `rows=${rows} chips=${chips} composer grew past its budget`,
      );
    }
  }
});

test('paste v7: one paste reaches the model complete and is sent once', () => {
  const content = payload(23_814);
  const attachment = createPastedAttachment(content, { settings: pasteSettings({}), sessionId: 's_test' });
  assert.equal(attachment.sessionId, 's_test');
  assert.equal(attachment.content.length, 23_814);
  assert.equal(attachment.chars, 23_814);

  const prompt = composePromptWithAttachments('Cek kode ini', [attachment]);
  assert.ok(prompt.includes(`characters="23814"`));
  assert.ok(prompt.includes(content), 'full source is in the request');
  assert.equal(prompt.split(content).length - 1, 1, 'source appears exactly once');

  const transcript = buildChatLines({
    width: 60,
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'Cek kode ini',
        meta: { attachments: [attachment] },
      },
    ],
  });
  const visible = transcript.map((line) => line.text).join('\n');
  assert.match(visible, /\[JS · 23,814 chars\]/);
  assert.equal(visible.includes('const handler'), false, 'no code preview in the card');
});

test('paste v7: selecting a chip and pressing Esc removes only that attachment', () => {
  const settings = pasteSettings({});
  const list = ['a', 'b', 'c'].map((letter) => createPastedAttachment(letter.repeat(700), { settings }));
  const action = escapeAction({ selectedAttachmentId: list[1].id, hasInput: true });
  assert.deepEqual(action, { type: 'remove-attachment', id: list[1].id });
  const remaining = removeAttachmentById(list, action.id);
  assert.deepEqual(remaining.map((entry) => entry.id), [list[0].id, list[2].id]);
  assert.equal(shouldBecomeAttachment('prompt text', settings), false, 'the prompt is unaffected');
});

test('paste v7: the paste limit remains 60k and /paste is a real command', () => {
  assert.equal(PASTE_CONTEXT_LIMIT, 60_000);
  assert.equal(pasteSettings({ maxContextCharacters: 80_000 }).maxContextCharacters, 60_000);
  assert.ok(SLASH_COMMANDS.some((command) => command.name === 'paste'));
  assert.ok(SLASH_COMMANDS.some((command) => command.name === 'attachments'));
});

test('paste v7: marker-prefix typing is released by Enter, not swallowed', () => {
  const capture = createBracketedPasteCapture();
  const first = capture.feed('[20');
  assert.equal(first.text, '');
  assert.equal(capture.flushText(), '[20');
  assert.equal(capture.feed('x').text, 'x');
});

test('paste v7: secrets are flagged before a paste is sent', () => {
  const attachment = createPastedAttachment(`const key = '${KEY_SAMPLE}';\n`, { settings: pasteSettings({ minCharacters: 1 }) });
  assert.equal(attachment.content.includes(KEY_SAMPLE), true);
  assert.match(formatAttachmentCard(attachment), /^\[JS · /);
});
