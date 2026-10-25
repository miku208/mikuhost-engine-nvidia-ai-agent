import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTextInput, previousGrapheme, nextGrapheme } from '../src/ui/input-edit.mjs';
import { describeKeyEvent } from '../src/ui/keyboard-inspector.mjs';
import { phaseLabel, phaseStatusLabel } from '../src/ui/components/activity.mjs';
import { PHASES } from '../src/core/events.mjs';
import { parseSgrMouse } from '../src/ui/mouse.mjs';
import { parseSlash, completeCommand, suggestCommands, HELP_TEXT } from '../src/ui/slash.mjs';
import { buildChatLines, wrapText, displayWidth } from '../src/ui/text-layout.mjs';
import { ModelRegistry, buildModelList, prettifyModelId } from '../src/models/registry.mjs';
import { maskTyped } from '../src/util/text.mjs';

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

test('input: insertion, cursor movement and deletion', () => {
  let state = applyTextInput('', 0, 'hello', key());
  assert.equal(state.value, 'hello');
  assert.equal(state.cursor, 5);

  state = applyTextInput(state.value, state.cursor, ' world', key());
  assert.equal(state.value, 'hello world');

  state = applyTextInput(state.value, state.cursor, '', key({ leftArrow: true }));
  assert.equal(state.cursor, 10);

  state = applyTextInput(state.value, state.cursor, 'X', key());
  assert.equal(state.value, 'hello worlXd');
  assert.equal(state.cursor, 11);

  state = applyTextInput(state.value, state.cursor, '', key({ backspace: true }));
  assert.equal(state.value, 'hello world');

  state = applyTextInput(state.value, 5, '', key({ delete: true }));
  assert.equal(state.value, 'helloworld');

  state = applyTextInput(state.value, 3, '', key({ home: true }));
  assert.equal(state.cursor, 0);
  state = applyTextInput(state.value, 0, '', key({ end: true }));
  assert.equal(state.cursor, state.value.length);
});

test('input: control shortcuts', () => {
  let state = applyTextInput('hello world', 11, 'a', key({ ctrl: true }));
  assert.equal(state.cursor, 0);
  state = applyTextInput('hello world', 0, 'e', key({ ctrl: true }));
  assert.equal(state.cursor, 11);
  state = applyTextInput('hello world', 11, 'w', key({ ctrl: true }));
  assert.equal(state.value, 'hello ');
  assert.equal(state.cursor, 6);
  state = applyTextInput('hello world', 5, 'u', key({ ctrl: true }));
  assert.equal(state.value, ' world');
  assert.equal(state.cursor, 0);
  state = applyTextInput('hello world', 5, 'k', key({ ctrl: true }));
  assert.equal(state.value, 'hello');
  assert.equal(state.cursor, 5);
});

test('input: Android/Termux DEL is Backspace while ESC[3~ stays forward Delete', () => {
  // Android SSH clients send 0x7f for Backspace. Ink normalizes it to
  // key.delete, which used to delete forward (and do nothing at end of line).
  let state = applyTextInput('helloo', 6, '', key({ delete: true }), '\u007f');
  assert.deepEqual(state, { changed: true, value: 'hello', cursor: 5 });

  // Cursor in the middle: "mikuhosst" -> left -> Backspace -> "mikuhost".
  state = applyTextInput('mikuhosst', 8, '', key({ delete: true }), '\u007f');
  assert.equal(state.value, 'mikuhost');
  assert.equal(state.cursor, 7);

  // BS (0x08) is also Backspace.
  state = applyTextInput('abc', 3, '', key({ backspace: true }), '\b');
  assert.equal(state.value, 'ab');

  // Forward Delete keeps its own semantics.
  state = applyTextInput('helloo', 4, '', key({ delete: true }), '\u001b[3~');
  assert.equal(state.value, 'hello');
  assert.equal(state.cursor, 4);

  // Meta+Backspace (ESC + DEL).
  state = applyTextInput('abc', 3, '', key({ meta: true }), '\u001b\u007f');
  assert.equal(state.value, 'ab');
});

test('input: batched bytes (fast typing / SSH writes) are processed in order', () => {
  let state = applyTextInput('', 0, 'abc\u007f\u007f', key(), 'abc\u007f\u007f');
  assert.equal(state.value, 'a');
  state = applyTextInput('', 0, 'ab\b', key(), 'ab\b');
  assert.equal(state.value, 'a');
  state = applyTextInput('xyz', 2, '', key({ delete: true }), '\u001b[3~');
  assert.equal(state.value, 'xy');
  // Rawless fallback still understands DEL inside normalized input.
  state = applyTextInput('abc', 3, '\u007f', key());
  assert.equal(state.value, 'ab');
});

test('input: bracketed paste markers are stripped, content is inserted once', () => {
  // Ink splits bracketed paste into marker + content + marker events.
  let state = applyTextInput('', 0, '[200~', key(), '\u001b[200~hello\u001b[201~');
  assert.deepEqual(state, { changed: false, value: '', cursor: 0 });
  state = applyTextInput(state.value, state.cursor, 'hello paste', key(), null);
  assert.equal(state.value, 'hello paste');
  state = applyTextInput(state.value, state.cursor, '[201~', key(), null);
  assert.equal(state.value, 'hello paste');

  // A runtime that delivers the whole paste in one event must also work.
  state = applyTextInput('', 0, '[200~one line[201~', key(), '\u001b[200~one line\u001b[201~');
  assert.equal(state.value, 'one line');
});

test('input: cursor movement and deletion follow Unicode graphemes', () => {
  const emoji = 'a\u{1F44D}\u{1F3FD}'; // 👍🏽 with skin tone
  assert.equal(previousGrapheme(emoji, emoji.length), 1);
  assert.equal(nextGrapheme(emoji, 1), emoji.length);
  assert.equal(applyTextInput(emoji, emoji.length, '', key({ leftArrow: true })).cursor, 1);
  assert.equal(applyTextInput(emoji, 1, '', key({ rightArrow: true })).cursor, emoji.length);
  assert.equal(applyTextInput(emoji, emoji.length, '', key({ delete: true }), '\u007f').value, 'a');
  assert.equal(applyTextInput(emoji, 1, '', key({ delete: true }), '\u001b[3~').value, 'a');
  const accented = 'e\u0301x';
  assert.equal(applyTextInput(accented, 2, '', key({ delete: true }), '\u007f').value, 'x');
});

test('keyboard inspector: classifies DEL, Delete and arrows without printing content', () => {
  const backspace = describeKeyEvent('\u007f', '', key({ delete: true }));
  assert.equal(backspace.kind, 'backspace');
  assert.equal(backspace.label, 'BACKSPACE');
  assert.equal(backspace.bytes, '7f');

  assert.equal(describeKeyEvent('\b', '', key({ backspace: true })).kind, 'backspace');
  const del = describeKeyEvent('\u001b[3~', '', key({ delete: true }));
  assert.equal(del.kind, 'delete');
  assert.match(del.label, /DELETE/);
  assert.equal(describeKeyEvent('\u001b[D', '', key({ leftArrow: true })).kind, 'left');

  const text = describeKeyEvent('secret', 'secret', key());
  assert.equal(text.label, 'TEXT');
  assert.equal(text.detail.includes('secret'), false);
  assert.match(text.bytes, /hidden/);
  assert.equal(text.bytes.includes('73'), false);
  assert.equal(text.inputLength, 6);
});

test('activity: phase labels and completion footer', () => {
  assert.equal(phaseLabel(PHASES.THINKING), 'Thinking');
  assert.equal(phaseLabel(PHASES.TOOL_EXECUTION), 'Working');
  assert.equal(phaseStatusLabel(PHASES.STREAMING), 'TYPING');
  assert.equal(phaseStatusLabel(PHASES.WAITING_APPROVAL), 'APPROVAL');

  const completed = buildChatLines({
    width: 70,
    messages: [{ role: 'assistant', content: 'All done.', meta: { durationMs: 8600 } }],
  });
  const text = completed.map((line) => line.text).join('\n');
  assert.match(text, /MikuHost\s+·\s+Completed in 8\.6s/);

  const stopped = buildChatLines({
    width: 70,
    messages: [{ role: 'assistant', content: 'Partial.', meta: { durationMs: 2500, aborted: true } }],
  });
  assert.match(stopped.map((line) => line.text).join('\n'), /Stopped in 2\.5s/);

  const typing = buildChatLines({ width: 70, messages: [], draft: { content: 'Hello' } });
  assert.match(typing.map((line) => line.text).join('\n'), /Typing\.\.\./);
});

test('input: pasted newlines become spaces and control bytes are dropped', () => {
  const state = applyTextInput('', 0, 'line one\nline\u0007 two\r\n', key());
  assert.equal(state.value, 'line one line two ');
  assert.equal(maskTyped('abcd'), '••••');
  assert.equal(maskTyped(''), '');
});

test('mouse: parses Ink SGR reports with or without the ESC prefix', () => {
  const withEsc = parseSgrMouse('\u001b[<0;10;24M');
  assert.deepEqual(withEsc, {
    button: 0,
    x: 10,
    y: 24,
    release: false,
    wheel: false,
    wheelUp: false,
    wheelDown: false,
    motion: false,
  });
  const withoutEsc = parseSgrMouse('[<0;10;24M');
  assert.equal(withoutEsc.x, 10);
  assert.equal(withoutEsc.y, 24);
  assert.equal(parseSgrMouse('plain text'), null);
  assert.equal(parseSgrMouse('[<64;5;10M').wheelUp, true);
  assert.equal(parseSgrMouse('[<65;5;10M').wheelDown, true);
  assert.equal(parseSgrMouse('[<0;10;24m').release, true);
});

test('slash: parsing, suggestions and tab completion', () => {
  assert.deepEqual(parseSlash('/model 2'), { name: 'model', args: '2', argv: ['2'] });
  assert.deepEqual(parseSlash('/help'), { name: 'help', args: '', argv: [] });
  assert.equal(parseSlash('hello'), null);

  assert.deepEqual(suggestCommands('/mo').map((command) => command.name), ['model', 'models', 'mouse']);
  assert.equal(completeCommand('/he'), '/help ');
  assert.equal(completeCommand('/model'), '/model');
  assert.equal(completeCommand('/zzz'), null);
  assert.match(HELP_TEXT, /Ctrl\+N/);
  assert.match(HELP_TEXT, /bracketed ✓/);
  assert.match(HELP_TEXT, /bracketed \?/);
});

test('layout: wraps text and renders tool cards without raw output', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('日本'), 4);
  const wrapped = wrapText('one two three four five', 9);
  assert.ok(wrapped.length > 1);
  assert.ok(wrapped.every((line) => displayWidth(line) <= 9));

  const lines = buildChatLines({
    width: 60,
    messages: [
      { role: 'user', content: 'find the bug' },
      { role: 'assistant', content: '```js\nconst a = 1;\n```\nThe fix is small.' },
      { role: 'tool', toolName: 'read_file', content: 'SECRET RAW OUTPUT', meta: { ok: true, path: 'src/a.js', durationMs: 12 } },
      { role: 'tool', toolName: 'run_command', content: 'TOOL ERROR (PERMISSION_DENIED): denied', meta: { ok: false } },
    ],
    notice: { text: 'Heads up', tone: 'warning' },
    draft: { content: 'streaming…' },
  });
  const text = lines.map((line) => line.text).join('\n');
  assert.match(text, /find the bug/);
  assert.match(text, /const a = 1/);
  assert.match(text, /read_file/);
  assert.match(text, /denied/);
  assert.equal(text.includes('SECRET RAW OUTPUT'), false);
  assert.match(text, /Heads up/);
  assert.match(text, /streaming/);
});

test('models: registry resolution by index, id, name and substring', () => {
  const registry = new ModelRegistry({ defaultModel: 'z-ai/glm-5.3-flash' });
  const list = registry.list();
  assert.equal(list.length, 6);
  assert.equal(registry.byIndex(1).id, 'z-ai/glm-5.3-flash');
  assert.equal(registry.byIndex(0), null);
  assert.equal(registry.byIndex(6).id, 'deepseek-ai/deepseek-v4.1-flash');
  assert.equal(registry.byIndex(7), null);
  assert.equal(registry.resolve('2').id, 'nvidia/nemotron-3.5-super-vl-120b-a12b');
  assert.equal(registry.resolve('z-ai/glm-5.3-flash').name, 'GLM 5.3 Flash');
  assert.equal(registry.resolve('glm 5.3 flash').id, 'z-ai/glm-5.3-flash');
  assert.equal(registry.resolve('laguna').id, 'poolside/laguna-xs-2.1');
  assert.equal(registry.resolve('deepseek v4.1 flash').id, 'deepseek-ai/deepseek-v4.1-flash');
  assert.equal(registry.resolve('deepseek-ai/deepseek-v4.1-flash').name, 'DeepSeek V4.1 Flash');
  assert.equal(registry.byId('deepseek-ai/deepseek-v4.1-flash').capabilities.tools, null);
  assert.throws(() => registry.resolve('nope'), /Unknown model/);
  assert.throws(() => registry.resolve(''), /required/);
  assert.throws(() => registry.resolve('a'), /ambiguous|Unknown/i);
});

test('models: user models merge, availability and capability honesty', () => {
  const list = buildModelList([{ id: 'custom/model', name: 'Custom' }, 'z-ai/glm-5.3-flash']);
  assert.equal(list.length, 7);
  assert.equal(list.find((model) => model.id === 'custom/model').source, 'config');
  assert.equal(list.find((model) => model.id === 'z-ai/glm-5.3-flash').capabilities.tools, null);
  assert.equal(prettifyModelId('nvidia/nemotron-3.5-super-vl-120b-a12b'), 'Nemotron 3.5 Super Vl 120b A12b');

  const registry = new ModelRegistry();
  assert.equal(registry.status('z-ai/glm-5.3-flash').status, 'unknown');
  registry.applyCatalogue(['z-ai/glm-5.3-flash']);
  assert.equal(registry.status('z-ai/glm-5.3-flash').status, 'available');
  assert.equal(registry.status('poolside/laguna-xs-2.1').status, 'unavailable');
  assert.deepEqual(registry.extraCatalogueModels(['brand/new-model']), ['brand/new-model']);
});
