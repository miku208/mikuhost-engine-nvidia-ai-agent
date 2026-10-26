import { theme, SYMBOLS } from './theme.mjs';
import { formatDuration } from '../util/text.mjs';
import { formatAttachmentCard, sanitizeForDisplay } from '../paste/attachments.mjs';

/** Approximate terminal display width (CJK/emoji count as 2 columns). */
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    if (code === 0x1b) continue;
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export function wrapText(text, width) {
  const limit = Math.max(8, Math.floor(width));
  const source = String(text ?? '');
  if (!source) return [''];
  const output = [];

  for (const rawLine of source.split('\n')) {
    if (rawLine === '') {
      output.push('');
      continue;
    }
    const indentMatch = /^[ \t]*/.exec(rawLine);
    const indent = indentMatch ? indentMatch[0].replace(/\t/g, '  ') : '';
    const body = rawLine.slice(indentMatch ? indentMatch[0].length : 0);
    const normalizedIndent = indent.length < limit - 8 ? indent : '';
    const available = Math.max(8, limit - displayWidth(normalizedIndent));

    let line = '';
    let lineWidth = 0;
    const words = body.split(' ');
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      const wordWidth = displayWidth(word);
      const separator = line.length ? 1 : 0;
      if (lineWidth + separator + wordWidth <= available) {
        line += `${line ? ' ' : ''}${word}`;
        lineWidth += separator + wordWidth;
        continue;
      }
      if (line) {
        output.push(normalizedIndent + line);
        line = '';
        lineWidth = 0;
      }
      if (wordWidth <= available) {
        line = word;
        lineWidth = wordWidth;
      } else {
        // Hard-split very long tokens (minified code, URLs, base64).
        let rest = word;
        while (displayWidth(rest) > available) {
          let cut = 0;
          let taken = 0;
          for (const char of rest) {
            const charWidth = displayWidth(char);
            if (taken + charWidth > available) break;
            taken += charWidth;
            cut += char.length;
          }
          if (cut === 0) cut = 1;
          output.push(normalizedIndent + rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
        lineWidth = displayWidth(rest);
      }
    }
    if (line || body === '') output.push(normalizedIndent + line);
  }
  return output;
}

function stripInlineMarkdown(text) {
  return String(text ?? '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1$2')
    .replace(/^#{1,6}\s+/, '');
}

/**
 * Convert session messages into a flat array of styled lines. The chat area is
 * a terminal-like buffer: scrolling slices this array instead of laying out
 * variable-height React elements.
 */
/**
 * The welcome header lives at the top of the transcript, not in a sticky
 * layout row. It scrolls away with the conversation.
 */
/**
 * Wrap a shell command for a preview that must not scroll off the screen.
 * Returns the visible lines plus how many wrapped lines were cut, so the caller
 * can say so instead of silently hiding the rest of the command.
 */
export function wrapCommandLines(command, width, limit = 8) {
  const lines = wrapText(String(command ?? ''), Math.max(8, width));
  const max = Math.max(1, Math.floor(limit));
  if (lines.length <= max) return { lines, hidden: 0 };
  return { lines: lines.slice(0, max), hidden: lines.length - max };
}

export function buildHeaderLines({ model = '—', workspace = '—', session = 'New Session', version = null, width = 80 } = {}) {
  const contentWidth = Math.max(20, width - 4);
  const rule = '─'.repeat(contentWidth);
  return [
    { text: `  ${SYMBOLS.bullet} MIKUHOST AGENT  ·  Multi-Model AI Coding Assistant`, color: theme.accent, bold: true },
    { text: `  Model      ${model}`, color: theme.dim },
    { text: `  Workspace  ${workspace}`, color: theme.dim },
    { text: `  Session    ${session}`, color: theme.dim },
    version ? { text: `  MikuHost Agent ${version}`, color: theme.faint, dim: true } : null,
    { text: `  ${rule}`, color: theme.border },
    { text: '' },
  ].filter(Boolean);
}

function pushReasoningBody(push, text, contentWidth) {
  const body = sanitizeForDisplay(text).replace(/\s+$/, '');
  if (!body) return;
  for (const rawLine of body.split('\n')) {
    const wrapped = wrapText(rawLine, contentWidth - 4);
    for (const line of wrapped) push(`  ${line}`, { color: theme.dim, dim: true });
  }
}

function reasoningLabel({ expanded, active, durationMs, showElapsedTime = true }) {
  const arrow = active && !expanded ? '▶' : expanded ? '▼' : '▶';
  if (active) return `${arrow} Reasoning (live)`;
  const duration = showElapsedTime && durationMs >= 100 ? ` for ${formatDuration(durationMs)}` : '';
  return `${arrow} Thought${duration}`;
}

export function buildChatLines({
  messages = [],
  draft = null,
  notice = null,
  width = 80,
  maxLines = 20000,
  reasoning = null,
  expandedReasoning = [],
  elapsedMs = 0,
} = {}) {
  const contentWidth = Math.max(20, width - 4);
  const lines = [];
  const push = (text, style = {}) => lines.push({ text, ...style });
  const expandedIds = new Set(Array.isArray(expandedReasoning) ? expandedReasoning : []);
  const showElapsedTime = reasoning?.showElapsedTime !== false;

  for (const message of messages) {
    if (message.role === 'user') {
      const wrapped = wrapText(message.content, contentWidth - 2);
      wrapped.forEach((line, index) => {
        if (index === 0) {
          push(`${SYMBOLS.prompt} ${line}`, { color: theme.user, bold: false });
        } else {
          push(`  ${line}`, { color: theme.user });
        }
      });
      const attachments = Array.isArray(message.meta?.attachments) ? message.meta.attachments : [];
      for (const attachment of attachments.slice(0, 3)) {
        push(`  ${formatAttachmentCard(attachment)}`, { color: theme.blue, dim: true });
      }
      if (attachments.length > 3) push(`  +${attachments.length - 3} more pasted attachments`, { color: theme.faint, dim: true });
      push('');
      continue;
    }

    if (message.role === 'assistant') {
      const hasToolCalls = Array.isArray(message.meta?.toolCalls) && message.meta.toolCalls.length > 0;
      const content = String(message.content ?? '').trim();
      if (!content && !hasToolCalls) continue;
      if (!content && hasToolCalls) continue; // tool cards describe the action
      const savedReasoning = typeof message.meta?.reasoning === 'string' ? message.meta.reasoning.trim() : '';
      if (savedReasoning) {
        const expanded = expandedIds.has(message.id);
        const label = reasoningLabel({
          expanded,
          active: false,
          durationMs: Number(message.meta?.reasoningMs) || 0,
          showElapsedTime,
        });
        push(`  ${label}`, {
          color: expanded ? theme.text : theme.dim,
          dim: !expanded,
          reasoningFor: message.id ?? null,
        });
        if (expanded) pushReasoningBody(push, savedReasoning, contentWidth);
      }
      const duration = Number(message.meta?.durationMs) || 0;
      const footer = duration
        ? `  ·  ${message.meta?.aborted ? 'Stopped' : 'Completed'} in ${formatDuration(duration)}`
        : '';
      push(`MikuHost${footer}`, { color: theme.accent, bold: true });
      const bodyLines = renderMarkdownBody(content, contentWidth - 2);
      for (const line of bodyLines) {
        push(`  ${line.text}`, line.style);
      }
      push('');
      continue;
    }

    if (message.role === 'tool') {
      const ok = message.meta?.ok !== false;
      const name = message.toolName ?? 'tool';
      const detail = toolDetail(message);
      const duration = message.meta?.durationMs ? formatDuration(message.meta.durationMs) : null;
      const suffix = [detail, duration].filter(Boolean).join(' · ');
      push(
        `  ${ok ? SYMBOLS.check : SYMBOLS.cross} ${name}${suffix ? `  ${suffix}` : ''}`,
        { color: ok ? theme.green : theme.red, dim: true },
      );
      if (!ok && message.content) {
        const reason = String(message.content).replace(/^TOOL ERROR[^:]*:\s*/, '').split('\n')[0];
        for (const line of wrapText(reason, contentWidth - 4)) push(`    ${line}`, { color: theme.red, dim: true });
      }
      continue;
    }

    if (message.role === 'system') {
      if (message.meta?.compaction) {
        push(`  ${SYMBOLS.diamond} context compacted`, { color: theme.faint, dim: true });
        push('');
      } else if (message.content) {
        for (const line of wrapText(message.content, contentWidth - 2)) push(`  ${line}`, { color: theme.dim, dim: true });
        push('');
      }
    }
  }

  if (notice) {
    const noticeLines = wrapText(notice.text, contentWidth - 2);
    noticeLines.forEach((line, index) => {
      push(`  ${index === 0 ? `${SYMBOLS.info} ` : '  '}${line}`, {
        color: notice.tone === 'error' ? theme.red : notice.tone === 'warning' ? theme.yellow : theme.blue,
        dim: true,
        notice: true,
      });
    });
    push('');
  }

  const hasLiveReasoning = Boolean(reasoning && (reasoning.active || String(reasoning.text ?? '').trim()));
  if (hasLiveReasoning) {
    const durationMs = reasoning.active
      ? Math.max(0, Number(elapsedMs) || 0)
      : Math.max(0, Number(reasoning.ms) || 0);
    const header = showElapsedTime && durationMs >= 100 ? `MIKUHOST ENGINE · ${formatDuration(durationMs)}` : 'MIKUHOST ENGINE';
    const expanded = reasoning.expanded !== false;
    push(header, { color: theme.accent, bold: true });
    push(`  ${reasoningLabel({ expanded, active: Boolean(reasoning.active), durationMs, showElapsedTime })}`, {
      color: reasoning.active ? theme.accent : theme.dim,
      dim: !reasoning.active && !expanded,
      reasoningFor: 'live',
    });
    if (expanded) pushReasoningBody(push, reasoning.text, contentWidth);
  }

  if (draft && draft.content) {
    if (hasLiveReasoning) {
      push(`  ${'─'.repeat(Math.max(10, contentWidth - 2))}`, { color: theme.border });
      push('MikuHost:', { color: theme.accent, bold: true });
    } else {
      const draftLabel = draft.typing === false ? 'Responding...' : 'Typing...';
      push(`MikuHost  ·  ${draftLabel}`, { color: theme.accent, bold: true });
    }
    const bodyLines = renderMarkdownBody(draft.content, contentWidth - 2);
    for (const line of bodyLines) push(`  ${line.text}`, line.style);
    push('');
  }

  if (lines.length > maxLines) {
    const trimmed = lines.slice(lines.length - maxLines);
    return [{ text: `  … earlier output trimmed (${lines.length - maxLines} lines)`, color: theme.faint, dim: true }, ...trimmed];
  }
  return lines;
}

function toolDetail(message) {
  const meta = message.meta ?? {};
  if (meta.command) return meta.command.length > 60 ? `${meta.command.slice(0, 57)}…` : meta.command;
  if (meta.path) return meta.path;
  if (meta.matches !== undefined) return `${meta.matches} matches`;
  if (meta.entries !== undefined) return `${meta.entries} entries`;
  return null;
}

function renderMarkdownBody(text, width) {
  const output = [];
  let inCode = false;
  for (const raw of String(text ?? '').split('\n')) {
    if (/^\s*```/.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      for (const line of wrapText(raw, width)) output.push({ text: line, style: { color: theme.code } });
      continue;
    }
    const heading = /^#{1,6}\s+/.test(raw);
    const cleaned = stripInlineMarkdown(raw);
    const style = heading ? { color: theme.text, bold: true } : { color: theme.text };
    if (/^\s*[-*]\s+/.test(raw)) {
      const bulletBody = wrapText(cleaned.replace(/^\s*[-*]\s+/, ''), width - 2);
      bulletBody.forEach((line, index) => {
        output.push({ text: index === 0 ? `• ${line}` : `  ${line}`, style });
      });
      continue;
    }
    for (const line of wrapText(cleaned, width)) output.push({ text: line, style });
  }
  return output;
}
