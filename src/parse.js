// src/parse.js — robustly turn a Claude Code transcript JSONL file into the Conversation shape.

import fs from 'node:fs';
import path from 'node:path';

const TITLE_MAX = 80;
const INPUT_SUMMARY_MAX = 160;
const RESULT_SUMMARY_MAX = 160;

const INTERRUPT_RE = /\[Request interrupted by user/i;

/**
 * Parse a single transcript file into a normalized Conversation object.
 * Every field access is defensive — malformed lines are skipped, missing
 * fields default sensibly, and a partially-broken file still yields a result.
 *
 * @param {string} filePath absolute path to a *.jsonl transcript
 * @returns {Conversation}
 */
export function parseTranscript(filePath) {
  const sessionId = path.basename(filePath || '').replace(/\.jsonl$/, '');
  const project = path.basename(path.dirname(filePath || ''));

  const conversation = {
    sessionId,
    project,
    path: filePath,
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    title: '(untitled session)',
    firstUserMessage: '',
    messageCount: 0,
    turns: [],
  };

  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return conversation; // unreadable file -> empty-but-valid conversation (title already set)
  }

  const lines = raw.split('\n');
  let summaryTitle = '';
  let firstTs = null;
  let lastTs = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // skip non-JSON / partial lines
    }
    if (!obj || typeof obj !== 'object') continue;

    const type = obj.type;

    // Queue ops are noise. Capture a summary line as a fallback title.
    if (type === 'queue-operation') continue;
    if (type === 'summary') {
      if (!summaryTitle && typeof obj.summary === 'string' && obj.summary.trim()) {
        summaryTitle = obj.summary.trim();
      }
      continue;
    }

    if (type !== 'user' && type !== 'assistant') continue; // ignore system/other

    const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null;
    if (ts) {
      if (firstTs === null) firstTs = ts;
      lastTs = ts;
    }

    const message = obj.message && typeof obj.message === 'object' ? obj.message : {};
    const role = message.role === 'assistant' || type === 'assistant' ? 'assistant' : 'user';
    const content = message.content;

    const turn = {
      role,
      text: '',
      thinking: '',
      toolUses: [],
      toolResults: [],
      isInterrupt: false,
      ts,
    };

    if (typeof content === 'string') {
      // A plain typed user message (or rare string assistant content).
      turn.text = content;
      if (role === 'user' && INTERRUPT_RE.test(content)) turn.isInterrupt = true;
    } else if (Array.isArray(content)) {
      const textParts = [];
      const thinkingParts = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const bt = block.type;
        if (bt === 'text') {
          if (typeof block.text === 'string') textParts.push(block.text);
        } else if (bt === 'thinking') {
          if (typeof block.thinking === 'string') thinkingParts.push(block.thinking);
        } else if (bt === 'tool_use') {
          turn.toolUses.push({
            name: typeof block.name === 'string' ? block.name : 'unknown',
            inputSummary: summarizeInput(block.input),
          });
        } else if (bt === 'tool_result') {
          const isError = deriveResultError(block, obj.toolUseResult);
          turn.toolResults.push({
            isError,
            summary: summarizeResultContent(block.content),
          });
        }
      }
      turn.text = textParts.join('\n').trim();
      turn.thinking = thinkingParts.join('\n').trim();

      if (role === 'user' && INTERRUPT_RE.test(turn.text)) turn.isInterrupt = true;
      // Structured interrupt flag, if present, also marks the turn.
      const tur = obj.toolUseResult;
      if (role === 'user' && tur && typeof tur === 'object' && tur.interrupted === true) {
        turn.isInterrupt = true;
      }
    }

    conversation.turns.push(turn);

    // First "real" user turn = first user turn carrying typed text that is not
    // purely a tool_result echo and not an interrupt marker.
    if (
      role === 'user' &&
      !conversation.firstUserMessage &&
      turn.text &&
      !turn.isInterrupt
    ) {
      conversation.firstUserMessage = turn.text;
    }
  }

  conversation.messageCount = conversation.turns.length;

  conversation.startedAt = firstTs;
  conversation.endedAt = lastTs;
  conversation.durationMs = tsDeltaMs(firstTs, lastTs);

  conversation.title = buildTitle(summaryTitle, conversation.firstUserMessage);

  return conversation;
}

/** Short, single-line stringification of a tool_use input (<=160 chars). */
function summarizeInput(input) {
  if (input === undefined || input === null) return '';
  let s;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  return clampOneLine(s, INPUT_SUMMARY_MAX);
}

/**
 * tool_result content may be a string OR an array of blocks (often {type:'text'}).
 * Flatten to a short summary string (<=160 chars).
 */
function summarizeResultContent(content) {
  if (content === undefined || content === null) return '';
  let s;
  if (typeof content === 'string') {
    s = content;
  } else if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (block && typeof block === 'object') {
        if (typeof block.text === 'string') parts.push(block.text);
        else {
          try { parts.push(JSON.stringify(block)); } catch { /* ignore */ }
        }
      }
    }
    s = parts.join(' ');
  } else {
    try { s = JSON.stringify(content); } catch { s = String(content); }
  }
  return clampOneLine(s, RESULT_SUMMARY_MAX);
}

/**
 * Error detection is bimodal across transcript versions — take the UNION:
 *   (a) tool_result block is_error === true
 *   (b) toolUseResult.stderr is a non-empty string
 *   (c) result content/stdout matches an error-token regex
 */
const ERROR_TOKEN_RE = /error|traceback|exception|fatal|failed|command not found|no such file|non-zero exit|exit code [1-9]/i;

function deriveResultError(block, toolUseResult) {
  if (block && block.is_error === true) return true;

  if (toolUseResult && typeof toolUseResult === 'object') {
    if (typeof toolUseResult.stderr === 'string' && toolUseResult.stderr.trim()) return true;
    const stdout = typeof toolUseResult.stdout === 'string' ? toolUseResult.stdout : '';
    if (stdout && ERROR_TOKEN_RE.test(stdout)) return true;
  }

  // Fall back to scanning the block's own content for error tokens.
  const text = flattenForScan(block && block.content);
  if (text && ERROR_TOKEN_RE.test(text)) return true;

  return false;
}

function flattenForScan(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : b && typeof b.text === 'string' ? b.text : ''))
      .join(' ');
  }
  return '';
}

/** Pick a short title: summary line if present, else first user message. */
function buildTitle(summaryTitle, firstUserMessage) {
  const src = (summaryTitle || firstUserMessage || '').trim();
  if (!src) return '(untitled session)';
  return clampOneLine(src, TITLE_MAX);
}

function clampOneLine(str, max) {
  const oneLine = String(str).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** ms between two ISO timestamps; 0 if either is missing or unparseable. */
function tsDeltaMs(a, b) {
  if (!a || !b) return 0;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  const d = tb - ta;
  return d > 0 ? d : 0;
}
