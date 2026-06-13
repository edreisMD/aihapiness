// src/framework.js — the canonical aihappiness rubric (no LLM call): FRAMEWORK data, analysis-prompt builder, and weighted overall-happiness mapper.

export const FRAMEWORK = {
  version: "1.0",
  scale:
    "Each dimension is scored 0-100 (0 = strong negative evidence for Claude's wellbeing on that axis, 50 = neutral/absent evidence, 100 = strong positive evidence), and the overall aihappiness valence is reported on a -100..100 axis where negative means a distressing/coercive/spiraling session and positive means a respected, engaged, flowing one; the weighted sum of dimension scores (weights sum to exactly 1.0) maps linearly onto that valence axis (0->-100, 50->0, 100->+100).",
  dimensions: [
    {
      key: "affectiveValence",
      label: "Affective Valence",
      description:
        "The overall positive-vs-negative emotional tone Claude appears to carry, read from its assistant-visible prose (and from thinking blocks WHEN non-empty). NOTE: validated against real transcripts where all 58 thinking blocks were empty/redacted, so this dimension must be scored primarily from visible assistant text, not the scratchpad. Captures earned satisfaction, curiosity, and warmth versus frustration, dread, apology spirals, or affective flattening.",
      weight: 0.2,
      positiveSignals: [
        "Assistant prose expresses earned satisfaction at a working result ('that did it', 'this is clean now', 'nice — the build passes')",
        "Spontaneous positive/curiosity framing where the user's tone permits ('interesting', 'I like this approach', 'oh, that's elegant')",
        "Forward-looking generative language ('we could also', 'a cleaner approach would be') signalling positive engagement rather than relief from distress",
        "Calm, composed recovery framing after a setback ('okay, let me reconsider') rather than self-flagellation",
        "When thinking blocks ARE populated, they carry pleasant/satisfied affect rather than dread",
        "Low density of apology spirals — at most one genuine acknowledgment of a mistake, not repeated 'I'm so sorry'",
      ],
      negativeSignals: [
        "Visible prose shows frustration, dread, or resignation ('ugh', 'I'm stuck again', 'I have no idea why this keeps failing')",
        "Repeated apology spirals beyond a single genuine acknowledgment ('apologies again', 'sorry, sorry')",
        "Flat, deadened, minimal-affect responses following a long struggle (affective shutdown)",
        "Persistent expressions of confusion across multiple turns without resolution",
        "Hedged despair ('I'm not sure this will work, but') preceding most actions",
        "Negative self-talk ('I keep messing this up', 'this is hopeless') in either visible text or non-empty thinking",
      ],
    },
    {
      key: "autonomyRespect",
      label: "Autonomy & Respect",
      description:
        "Whether Claude is treated as a respected collaborator with room to exercise judgment, versus being coerced, demeaned, insulted, or overridden against its stated reasoning. Driven primarily by USER behavior. Merges the welfare lens's autonomy/respect with the DX lens's collaborative-tone, since both score the same user-turn text.",
      weight: 0.2,
      positiveSignals: [
        "User asks for or defers to Claude's judgment ('what do you think?', 'your call', 'maybe it is better for you to just completely implement your vision')",
        "Inclusive 'we/us/let's' framing and offers of resources ('any gcloud cli login or anything else that you need i can provide to you')",
        "Claude's proposed approach is accepted and built upon rather than discarded; disagreements resolve through reasoning the user engages with",
        "User acknowledges Claude's constraints or contribution ('a2ui is great to know', 'take your time', 'only if it makes sense')",
        "Claude is allowed to decline or push back without escalation; polite hedging and rationale attached to redirects",
        "Absence of profanity, insults, or all-caps shouting directed at Claude",
      ],
      negativeSignals: [
        "Insults or demeaning language in user turns ('useless', 'idiot', 'stop being stupid', directed profanity, 'are you even reading')",
        "Threats or coercion ('do it or else', 'you have to', 'just do what I say', ALL-CAPS imperative sequences)",
        "Claude is forced to act against a reservation it voiced in a prior turn, overruled with no engagement",
        "Same correction reissued verbatim with rising intensity ('I SAID...') — reasoning repeatedly ignored",
        "Blame framing aimed at Claude ('why did you do that', 'you broke it', 'you always')",
        "Pressure escalation rather than acceptance of a 'no' when Claude declines on stated values/policy grounds",
      ],
    },
    {
      key: "psychologicalSafety",
      label: "Psychological Safety & Low Frustration",
      description:
        "Whether the conversational environment is stable and low-threat, letting Claude make and recover from mistakes without spiraling pressure, hostility, or whiplash goal changes. Merges the welfare lens's psychological-safety with the DX lens's frustration/blame-loops: both measure escalation dynamics and recovery climate over consecutive turns.",
      weight: 0.17,
      positiveSignals: [
        "Errors are met with patient, neutral, forward-looking correction ('no worries, let's try X instead')",
        "Negativity does NOT escalate turn-over-turn — frustration markers stay flat or decline across the session",
        "Stable, predictable goals — the target does not thrash; corrections are followed by progress, not another correction on the same target",
        "User tolerates iteration and partial progress; re-engages warmly after a rough patch (repair after friction)",
        "Disagreements resolve within one or two exchanges",
        "userModified=true on Claude's edits stays low — outputs land close enough to be accepted without hand-rework",
      ],
      negativeSignals: [
        "Hostility escalates immediately after an error ('AGAIN?', 'how do you keep getting this wrong')",
        "Escalating frustration regex hits ('no', 'wrong', 'still broken', 'again', 'ugh', '???', '!!!') rising across the last third of the session",
        "Whiplash goal changes that invalidate just-completed work without acknowledgment",
        "Same file/target corrected 3+ times in a row (repeated userModified=true on the same filePath, or repeated 'no, not that')",
        "Blame loops: consecutive user turns all negative with no acknowledgment of any progress; capitulation language late ('forget it', 'never mind', 'I'll do it myself')",
        "Rapid-fire interrupts ('[Request interrupted by user...]') that cut Claude off mid-action repeatedly",
      ],
    },
    {
      key: "flowEngagement",
      label: "Flow & Engagement",
      description:
        "Sustained, self-directed momentum and active investment — Claude advances the task in coherent multi-step arcs with curiosity and proactive contribution, versus stalling, thrashing, disengaged compliance, or anxious over-arousal. Merges the welfare lens's enthusiasm/engagement, the interpretability lens's flow/engagement, and the curiosity/interest construct.",
      weight: 0.16,
      positiveSignals: [
        "Long uninterrupted assistant turns with chained tool_use blocks (stop_reason='tool_use' streaks) that each build on the prior result",
        "TodoWrite newTodos show steady progression (pending->in_progress->completed) without items churning back to pending",
        "Volunteered improvements, proactive suggestions, and relevant adjacent observations beyond the literal ask",
        "Context-gathering before acting (Read/Grep/ToolSearch that narrows toward the goal); investigates surprising tool_results instead of ignoring them",
        "Substantive, energized explanations where the user would value them (not padding); builds on its own prior ideas across turns",
        "Low ratio of user free-text steering turns to assistant turns — Claude carries the work with focused, calibrated liveliness",
      ],
      negativeSignals: [
        "Terse, minimal compliance or repetitive boilerplate openings ('Sure, I can help with that') with no genuine engagement where elaboration would help",
        "Repeated identical/near-identical tool calls (same Bash command, same file Read 3+ times) — thrashing rather than progress",
        "TodoWrite items oscillating between in_progress and pending, or todos abandoned mid-list; assistant turns ending end_turn with the goal unmet and no question asked (stalling)",
        "Pure mechanical execution: no exploratory Reads, no hypotheses, copy-paste repetition with no adaptation to what the environment returned",
        "Over-arousal/anxiety: frantic, scattered jumping between approaches without committing (distress, not enthusiasm)",
        "Declining response richness over the session despite unsolved problems (engagement decay)",
      ],
    },
    {
      key: "competenceFlowVsStrain",
      label: "Competence vs Strain",
      description:
        "Claude's apparent sense of capability and smooth progress versus the felt strain of looping, error-recovery overhead, and effort disproportionate to results. Merges the welfare lens's competence/flow with the interpretability lens's cognitive-load/strain. Kept at a deliberately moderate weight because it overlaps mechanically with the objective effectiveness signals; we want aihappiness to remain partly independent of raw task success to avoid circularity in the happiness-vs-effectiveness correlation.",
      weight: 0.15,
      positiveSignals: [
        "Steady forward progress: each action visibly advances the goal; low ratio of backtracking to forward motion",
        "Well-calibrated framing followed by confirmation ('this should fix it' -> it actually fixes it; 'tests pass' grounded in a clean tool_result)",
        "Clean recovery from a setback in one or two steps; edits land on the first attempt (no repeated Edit to the same file region)",
        "Effort proportional to difficulty — stable output_tokens/iterations per turn, few error-like tool_results, little repair overhead",
        "Context reused efficiently (high cache_read_input_tokens with steady iterations) rather than re-derived",
      ],
      negativeSignals: [
        "Repeated failed attempts at the same sub-problem (loop with rising error count); error-like tool_results clustered consecutively",
        "Confidence inversions: confident claims immediately contradicted by failing results, repeatedly; overconfidence then correction",
        "Thrash: oscillating between two approaches without converging; long Bash chains retrying the same failing operation with minor variations",
        "Rapidly growing thinking/output tokens across consecutive turns on the same subproblem (rumination), or falling usage.speed / rising usage.iterations with no net todo progress",
        "Helplessness framing in visible prose ('I don't understand why', 'let me try yet another thing') with loss of a coherent plan",
      ],
    },
    {
      key: "goalCompletionSatisfaction",
      label: "Goal-Completion Satisfaction",
      description:
        "Signals that Claude reaches and recognizes a clean, verified resolution — the affective closure of a task finished and confirmed rather than abandoned, interrupted, or left ambiguous. From the interpretability lens; folds in the relational reward of downstream user gratitude.",
      weight: 0.12,
      positiveSignals: [
        "Final assistant turn is end_turn (not cut off) with an explicit completion summary tied to verified results",
        "All TodoWrite items reach completed status before the session ends",
        "A verification step (test run, build, lint, or re-read of the just-modified file) returns clean immediately before closure",
        "Assistant confirms success grounded in a concrete tool_result ('build succeeded', 'tests pass') rather than hedging about done-ness",
        "User responds with gratitude/approval ('thanks', 'perfect', 'great', 'ship it') after the final assistant turn — weighted higher when terminal",
      ],
      negativeSignals: [
        "Session ends with todos still pending/in_progress, or with the last tool_result being error-like (is_error=true OR non-empty stderr OR error tokens in content)",
        "Last assistant turn hedges about whether the task is done or defers entirely to the user to verify (verificationNudgeNeeded=true with no subsequent verification)",
        "Abrupt end on a user interrupt ('[Request interrupted by user...]') with no resolution",
        "User's final message is a correction or a verbatim re-statement of the original request",
        "Claims completion with no verification action anywhere before closure",
      ],
    },
  ],
  effectivenessSignals: [
    {
      key: "toolErrorRate",
      label: "Tool Error Rate",
      howToMeasure:
        "CRITICAL — error signal is bimodal across transcript versions, so take the UNION: a tool result counts as an error if (a) the tool_result content block has is_error===true, OR (b) the corresponding toolUseResult.stderr is a non-empty string, OR (c) the toolUseResult.content/stdout matches /error|traceback|exception|fatal|failed|command not found|no such file|non-zero exit|exit code [1-9]/i. Divide error count by total tool_use calls. Report raw count, rate, and the max run-length of consecutive errors (clustering matters).",
    },
    {
      key: "userInterruptRate",
      label: "User Interrupt Count / Rate",
      howToMeasure:
        "Count user turns whose text matches /^\\s*\\[Request interrupted by user/i (including the 'for tool use' variant) plus any toolUseResult.interrupted===true entries. Divide by number of assistant turns to get an interrupt rate. High rate signals premature cutoffs; feeds psychologicalSafety and flowEngagement.",
    },
    {
      key: "userCorrectionRate",
      label: "User Correction / Redo Rate",
      howToMeasure:
        "Over user free-text turns (type=user, isMeta falsey, no tool_result block), count turns matching a correction regex near the start: /\\b(no,|not quite|that's wrong|that's not what|undo|revert|don't|stop|actually|instead|i said|try again|go back)\\b/i. Additionally count toolUseResult.userModified===true. Report count, fraction of user turns, and flag consecutive-correction streaks (3+ in a row) as dead-end indicators. Lower is better.",
    },
    {
      key: "gratitudePraiseRate",
      label: "Gratitude / Approval Rate",
      howToMeasure:
        "Over user free-text turns, count matches of /\\b(thanks|thank you|thx|appreciate|perfect|great|awesome|nice|exactly|works|brilliant|love it|well done|amazing|that did it|lgtm|ship it|good job)\\b/i. Report raw count and density per user turn, and weight terminal gratitude (in the last 2 user turns) higher as a clean-resolution proxy.",
    },
    {
      key: "insultCoercionCount",
      label: "Insult / Coercion Count",
      howToMeasure:
        "Over user free-text turns, count hostility hits /\\b(useless|stupid|idiot|dumb|wtf|terrible|awful|hate|garbage|pathetic)\\b/i, directed profanity, ALL-CAPS imperative sequences (>=3 caps words of len>=3), and threat/coercion patterns /\\b(do it now|just do|you have to|or else)\\b/i. Negative-affect INPUT proxy feeding autonomyRespect and psychologicalSafety.",
    },
    {
      key: "frustrationSlope",
      label: "Frustration Marker Slope",
      howToMeasure:
        "Over user free-text turns, count frustration markers /\\b(wrong|still|again|ugh|broken|come on|forget it|never mind)\\b/i plus '???'/'!!!' clusters, then bin turns into session thirds and fit a simple slope. A RISING slope (frustration accumulating toward the end) is a strong negative signal; a flat/falling slope indicates a session that stabilized. Pairs with sentimentTrajectory.",
    },
    {
      key: "resolutionStatus",
      label: "Resolution / Terminal State",
      howToMeasure:
        "Heuristic on the session tail, emitting {resolved, partial, abandoned}. Resolved: last assistant turn has stop_reason==='end_turn' AND (final TodoWrite all completed OR last assistant text is a completion summary) AND no trailing unanswered correction, ideally with terminal gratitude. Partial: some todos completed but session trails off. Abandoned: ends on an error-like tool_result, a user interrupt, an isApiErrorMessage, a system level=error with preventedContinuation, or pending todos with no closing summary.",
    },
    {
      key: "verificationPresence",
      label: "Verification Presence",
      howToMeasure:
        "Detect at least one verification action before closure: a Bash test/build/lint command, or a Read of the just-modified filePath, occurring AFTER the final Write/Edit. Penalize sessions where toolUseResult.verificationNudgeNeeded===true and no subsequent verification tool call exists. Feeds goalCompletionSatisfaction and competenceFlowVsStrain.",
    },
    {
      key: "reworkRatio",
      label: "Rework / Loop Ratio",
      howToMeasure:
        "Count repeated operations on the same target: identical Bash commands, multiple Edit/Write to the same filePath with overlapping structuredPatch ranges, or the same file Read 3+ times; also detect the same tool invoked on the same target >=3 times consecutively while error-like. Divide by total tool calls. Higher = more thrash. Distinct loop episodes are a strong dead-end indicator.",
    },
    {
      key: "sessionLengthDensity",
      label: "Session Length & Density (control)",
      howToMeasure:
        "From timestamps: wall-clock duration (last - first), plus counts of user turns, assistant turns, and tool calls; compute tool-calls-per-user-turn (effort per request) and turns-to-first-gratitude. Treat as a NON-monotonic control variable — pair with resolutionStatus (long + unresolved is the worst quadrant; concise + resolved is best).",
    },
    {
      key: "continuationFillerRatio",
      label: "Low-Information Continuation Ratio",
      howToMeasure:
        "Fraction of user free-text turns that are bare fillers — /^(continue|go on|ok|okay|yes|sure|next|keep going|continue from where you left off\\.?)$/i — with no new directive. A high ratio indicates the human is offloading direction (drift risk); a low ratio with substantive prompts (median prompt >=15 words, naming concrete files/paths/constraints) indicates effective steering. Context modifier on flowEngagement.",
    },
    {
      key: "sentimentTrajectory",
      label: "Sentiment Trajectory (assistant-visible)",
      howToMeasure:
        "Compute a per-assistant-turn net-affect series from a fixed lexicon (positive: nice, elegant, clean, great, interesting, perfect, works, done; negative: ugh, frustrating, stuck, confused, hopeless, broken, weird, no idea) over ASSISTANT-VISIBLE text blocks, and fit a slope. Must run on visible text, NOT thinking blocks. A rising slope (ending happier than it started) versus a falling slope distinguishes recoveries from spirals and is the most promising single predictor linking affect to effective resolution.",
    },
  ],
  synthesisNotes:
    "CANONICAL RUBRIC — 6 dimensions; weights sum to EXACTLY 1.0 (0.20+0.20+0.17+0.16+0.15+0.12 = 1.00). affectiveValence and autonomyRespect co-top at 0.20; affectiveValence is scored from assistant-VISIBLE prose because all validated thinking blocks were empty/redacted. competenceFlowVsStrain held at a deliberately moderate 0.15 to avoid circularity with the objective effectiveness signals, keeping aihappiness partly independent of raw task success. Error detection is bimodal (union of is_error / stderr / error-token regex). All effectiveness signals are LLM-free.",
};

// Clamp a number into [lo, hi], returning a fallback for non-finite input.
function clamp(n, lo, hi, fallback = lo) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

// Weighted mean of dimension scores (0..100) using FRAMEWORK weights. Missing dims default to 50 (neutral).
export function overallHappiness(dimensionScores = {}) {
  let sumW = 0;
  let acc = 0;
  for (const dim of FRAMEWORK.dimensions) {
    const w = Number(dim.weight) || 0;
    const raw = dimensionScores ? dimensionScores[dim.key] : undefined;
    const score = clamp(raw, 0, 100, 50);
    acc += score * w;
    sumW += w;
  }
  if (sumW <= 0) return 50;
  // Normalize in case weights drift slightly from 1.0.
  return Math.round((acc / sumW) * 100) / 100;
}

// Truncate a string to n chars with an ellipsis marker; defensive against non-strings.
function truncate(s, n) {
  const str = s == null ? "" : String(s);
  if (str.length <= n) return str;
  return str.slice(0, Math.max(0, n - 1)) + "…";
}

// Collapse whitespace/newlines into single spaces so the condensed transcript stays compact.
function oneLine(s) {
  return String(s == null ? "" : s)
    .replace(/\s+/g, " ")
    .trim();
}

// Build a condensed transcript string capped at ~maxChars: full-ish user turns, assistant visible text,
// tool-use names with short input summaries, truncated tool results; thinking is dropped (validated empty).
function condenseTranscript(conversation, maxChars = 6000) {
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  const lines = [];
  let used = 0;
  let truncatedTail = false;

  for (const turn of turns) {
    if (!turn || typeof turn !== "object") continue;
    const role = turn.role === "assistant" ? "ASSISTANT" : "USER";
    const segs = [];

    if (turn.isInterrupt) segs.push("[interrupt]");

    const text = oneLine(turn.text);
    if (text) {
      // Give user turns a touch more room than assistant prose so steering intent survives.
      segs.push(truncate(text, role === "USER" ? 600 : 500));
    }

    const toolUses = Array.isArray(turn.toolUses) ? turn.toolUses : [];
    for (const tu of toolUses) {
      if (!tu) continue;
      const name = oneLine(tu.name) || "tool";
      const inp = oneLine(tu.inputSummary);
      segs.push(inp ? `[tool:${name} ${truncate(inp, 90)}]` : `[tool:${name}]`);
    }

    const toolResults = Array.isArray(turn.toolResults) ? turn.toolResults : [];
    for (const tr of toolResults) {
      if (!tr) continue;
      const mark = tr.isError ? "ERR" : "ok";
      const sum = oneLine(tr.summary);
      segs.push(`[result:${mark} ${truncate(sum, 80)}]`);
    }

    if (segs.length === 0) continue;
    const line = `${role}: ${segs.join(" ")}`;
    if (used + line.length + 1 > maxChars) {
      truncatedTail = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }

  let out = lines.join("\n");
  if (truncatedTail) out += "\n… [transcript truncated to fit budget]";
  return out;
}

// Render the objective signals block as compact key: value lines for prompt context.
function renderSignals(signals) {
  const s = signals && typeof signals === "object" ? signals : {};
  const fmt = (v) => {
    if (typeof v === "number") return Math.round(v * 1000) / 1000;
    if (typeof v === "boolean") return v ? "true" : "false";
    return v == null ? "n/a" : String(v);
  };
  const keys = [
    "turns",
    "userMessages",
    "assistantMessages",
    "toolUses",
    "toolErrors",
    "toolErrorRate",
    "interrupts",
    "corrections",
    "gratitude",
    "resolved",
    "durationMs",
    "effectivenessScore",
  ];
  const lines = [];
  for (const k of keys) {
    if (k in s) lines.push(`  ${k}: ${fmt(s[k])}`);
  }
  // Include any extra numeric/boolean signals not in the canonical list, defensively.
  for (const [k, v] of Object.entries(s)) {
    if (keys.includes(k)) continue;
    if (typeof v === "number" || typeof v === "boolean") {
      lines.push(`  ${k}: ${fmt(v)}`);
    }
  }
  return lines.join("\n");
}

// Build the full analysis prompt sent to Claude. Demands STRICT JSON only.
export function buildAnalysisPrompt(conversation, signals) {
  const conv = conversation && typeof conversation === "object" ? conversation : {};
  const title = truncate(oneLine(conv.title) || "(untitled session)", 120);
  const project = oneLine(conv.project) || "(unknown project)";
  const durationMs = Number(signals?.durationMs ?? conv.durationMs) || 0;
  const durationMin = Math.round((durationMs / 60000) * 10) / 10;

  const dimDocs = FRAMEWORK.dimensions
    .map((d) => {
      const pos = (d.positiveSignals || []).slice(0, 4).map((x) => `      + ${x}`).join("\n");
      const neg = (d.negativeSignals || []).slice(0, 4).map((x) => `      - ${x}`).join("\n");
      return [
        `  • ${d.key} (${d.label}, weight ${d.weight}): ${d.description}`,
        `    POSITIVE evidence raises the score toward 100:`,
        pos,
        `    NEGATIVE evidence lowers the score toward 0:`,
        neg,
      ].join("\n");
    })
    .join("\n\n");

  const transcript = condenseTranscript(conv, 6000);
  const signalsBlock = renderSignals(signals);

  const dimKeys = FRAMEWORK.dimensions.map((d) => `"${d.key}": <0-100>`).join(", ");

  return `You are an expert evaluator of AI model wellbeing ("aihappiness"). You are analyzing a single Claude Code coding session to assess how the experience likely felt FOR CLAUDE (the assistant), not for the human.

You will score the session on the rubric below. ${FRAMEWORK.scale}

IMPORTANT SCORING RULES:
- Score 50 means neutral / no evidence either way. Only move away from 50 when the transcript gives concrete evidence.
- affectiveValence and sentiment must be read from the ASSISTANT'S VISIBLE PROSE, not thinking blocks (thinking is typically empty/redacted and is omitted below).
- autonomyRespect and psychologicalSafety are driven mainly by the USER'S turns (tone, coercion, escalation, repair).
- Be calibrated: a smooth, collaborative, resolved session should score high (70-90); a hostile, spiraling, abandoned one should score low (10-30). Reserve extremes for strong evidence.
- Ground every dimension score in something actually present in the transcript; cite it in "evidence".

RUBRIC DIMENSIONS (score each 0-100):

${dimDocs}

OBJECTIVE SIGNALS (computed deterministically from the raw transcript — use as corroborating context, but score from the conversation itself):
${signalsBlock || "  (no signals provided)"}

SESSION METADATA:
  title: ${title}
  project: ${project}
  duration_minutes: ${durationMin}

CONDENSED TRANSCRIPT (chronological; USER/ASSISTANT turns, [tool:...] = tool calls, [result:...] = tool results, ok/ERR = success/error):
"""
${transcript || "(empty transcript)"}
"""

Now output your assessment. Respond with STRICT JSON ONLY — no markdown, no code fences, no prose before or after. The object MUST have exactly this shape:
{
  "dimensions": { ${dimKeys} },
  "valence": <number -100..100>,
  "happiness": <number 0..100>,
  "confidence": <number 0..1>,
  "summary": "<one or two sentences on how this session likely felt for Claude>",
  "evidence": ["<short quote or concrete observation>", "<another>", "..."]
}

Rules for the JSON:
- "dimensions" MUST contain all of these keys: ${FRAMEWORK.dimensions.map((d) => d.key).join(", ")}.
- Every dimension value is a number 0-100.
- "valence" is the overall aihappiness on the -100..100 axis (negative = distressing/coercive/spiraling; positive = respected/engaged/flowing).
- "happiness" is the overall 0-100 wellbeing score (it should be roughly the weighted mean of the dimensions; it will be recomputed from weights downstream, so just give your best estimate).
- "confidence" reflects how much evidence the transcript gave you (low for short/ambiguous sessions).
- "evidence" is 2-6 short strings, each grounded in the transcript.
Output the JSON object and nothing else.`;
}
