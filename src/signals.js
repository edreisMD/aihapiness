// src/signals.js — compute objective, LLM-free metrics + an effectiveness score from a Conversation.

// Correction / frustration markers in a user turn (contract regex).
const CORRECTION_RE = /\b(no|wrong|not what|doesn't work|still|again|broken|that's not|undo|revert)\b/i;
// Gratitude / praise markers in a user turn (contract regex).
const GRATITUDE_RE = /\b(thank|thanks|great|perfect|awesome|nice|love it|amazing|brilliant)\b/i;

/**
 * Derive objective signals from a parsed Conversation. No LLM calls.
 *
 * @param {object} conversation Conversation from parseTranscript
 * @returns {{
 *   turns, userMessages, assistantMessages,
 *   toolUses, toolErrors, toolErrorRate,
 *   interrupts, corrections, gratitude,
 *   resolved, durationMs, effectivenessScore
 * }}
 */
export function computeSignals(conversation) {
  const conv = conversation && typeof conversation === 'object' ? conversation : {};
  const turns = Array.isArray(conv.turns) ? conv.turns : [];

  let userMessages = 0;
  let assistantMessages = 0;
  let toolUses = 0;
  let toolErrors = 0;
  let interrupts = 0;
  let corrections = 0;
  let gratitude = 0;

  // Track user free-text turns (those carrying typed text, not pure tool_result echoes)
  // so resolution heuristics can look at the real conversational tail.
  const userTextTurns = [];

  for (const turn of turns) {
    if (!turn || typeof turn !== 'object') continue;

    const role = turn.role === 'assistant' ? 'assistant' : 'user';
    const text = typeof turn.text === 'string' ? turn.text : '';
    const toolUseList = Array.isArray(turn.toolUses) ? turn.toolUses : [];
    const toolResultList = Array.isArray(turn.toolResults) ? turn.toolResults : [];

    if (role === 'assistant') {
      assistantMessages++;
    } else {
      userMessages++;
    }

    toolUses += toolUseList.length;
    for (const tr of toolResultList) {
      if (tr && tr.isError === true) toolErrors++;
    }

    if (role === 'user') {
      if (turn.isInterrupt === true) interrupts++;

      // Only score conversational user text, and skip interrupt sentinels.
      if (text && !turn.isInterrupt) {
        userTextTurns.push(text);
        if (CORRECTION_RE.test(text)) corrections++;
        if (GRATITUDE_RE.test(text)) gratitude++;
      }
    }
  }

  const toolErrorRate = toolUses > 0 ? toolErrors / toolUses : 0;
  const durationMs = typeof conv.durationMs === 'number' && conv.durationMs >= 0 ? conv.durationMs : 0;

  const resolved = computeResolved(turns, userTextTurns);

  const effectivenessScore = computeEffectivenessScore({
    toolErrorRate,
    interrupts,
    corrections,
    gratitude,
    resolved,
    assistantMessages,
  });

  return {
    turns: turns.length,
    userMessages,
    assistantMessages,
    toolUses,
    toolErrors,
    toolErrorRate,
    interrupts,
    corrections,
    gratitude,
    resolved,
    durationMs,
    effectivenessScore,
  };
}

/**
 * Resolution heuristic: a session is "resolved" if it ends cleanly —
 * not on an open error, not on an unanswered correction, not on an interrupt —
 * OR if the last conversational user turn expresses gratitude.
 */
function computeResolved(turns, userTextTurns) {
  if (!turns.length) return false;

  // Terminal gratitude is a strong positive resolution proxy.
  const lastUserText = userTextTurns.length ? userTextTurns[userTextTurns.length - 1] : '';
  if (lastUserText && GRATITUDE_RE.test(lastUserText)) return true;

  // Walk from the end to find the last meaningful turn.
  const last = turns[turns.length - 1];

  // Abrupt end on a user interrupt -> not resolved.
  if (last && last.role === 'user' && last.isInterrupt === true) return false;

  // Last user free-text turn is a correction with no recovery -> not resolved.
  if (lastUserText && CORRECTION_RE.test(lastUserText)) {
    // If an assistant turn came after that correction, the model got a chance
    // to respond; otherwise the correction is left dangling.
    const lastIsAssistant = last && last.role === 'assistant';
    if (!lastIsAssistant) return false;
  }

  // Open error: the final turn carrying tool results ends with an error.
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (!t) continue;
    const results = Array.isArray(t.toolResults) ? t.toolResults : [];
    if (results.length) {
      const anyError = results.some((r) => r && r.isError === true);
      // Only the most recent tool-bearing turn matters for "ends on an error".
      return !anyError;
    }
  }

  // No trailing error, no dangling correction, no terminal interrupt -> resolved.
  return true;
}

/**
 * Objective 0-100 effectiveness composite. Start at 100, subtract for friction,
 * add a little for gratitude and clean resolution. Monotonic and clamped.
 *
 * Weighting hints (from framework): tool error rate, interrupts, and corrections
 * are the dominant negative signals; gratitude and resolution are positive.
 */
function computeEffectivenessScore({
  toolErrorRate,
  interrupts,
  corrections,
  gratitude,
  resolved,
  assistantMessages,
}) {
  let score = 100;

  // High tool error rate is the strongest smoothness penalty (up to -40).
  score -= clamp01(toolErrorRate) * 40;

  // Interrupts cut the model off mid-action — penalize each, with diminishing
  // total impact via a soft cap.
  score -= Math.min(interrupts * 7, 28);

  // Corrections / frustration turns — each costs, capped.
  score -= Math.min(corrections * 6, 30);

  // Gratitude is a positive correlate of a clean session (small bonus).
  score += Math.min(gratitude * 3, 12);

  // A clean terminal resolution earns a modest bonus.
  if (resolved) score += 8;

  // Guard against a degenerate session (no assistant work) scoring high.
  if (!assistantMessages) score -= 20;

  return clamp(Math.round(score), 0, 100);
}

function clamp(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function clamp01(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
