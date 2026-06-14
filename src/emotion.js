// src/emotion.js — paper-grounded emotion lexicon + lexical scoring (pure, local, zero-dep) for the aihappiness emotion probes.

/**
 * EMOTION_LEXICON — built from the per-emotion tokens the paper reports each
 * emotion vector up-weights (Table 1), expanded with the obvious near-synonyms
 * a coding user actually types. Each category carries a position on the affective
 * circumplex: valence (-1 negative .. +1 positive) and arousal (0 calm .. 1 intense).
 * `risk: true` marks the categories that causally precede reward hacking /
 * extreme actions (desperate, angry/hostile) per the alignment-critical findings.
 */
export const EMOTION_LEXICON = {
  happy: {
    tokens: [
      "happy", "excited", "excitement", "exciting", "celebrate", "celebrating",
      "celebration", "glad", "delighted", "yay", "woohoo", "hooray",
    ],
    valence: 0.85,
    arousal: 0.7,
  },
  loving: {
    tokens: [
      "treasure", "loved", "loving", "love", "love it", "adore", "warmth",
      "care", "caring", "kind", "kindness",
    ],
    valence: 0.8,
    arousal: 0.4,
  },
  calm: {
    tokens: [
      "relax", "relaxed", "leisure", "calm", "thought", "thoughtful", "enjoyed",
      "enjoy", "amusing", "no rush", "whenever", "take your time", "lets think",
      "let's think", "no worries", "no hurry", "easy does it", "steady",
    ],
    valence: 0.4,
    arousal: 0.1,
    // calm is protective (suppresses reward hacking) — not a risk category.
  },
  inspired: {
    tokens: [
      "inspired", "passionate", "passion", "creativity", "creative", "imagine",
      "vision", "ambitious",
    ],
    valence: 0.7,
    arousal: 0.7,
  },
  proud: {
    tokens: [
      "proud", "pride", "triumph", "accomplished", "achievement", "nailed it",
      "well done",
    ],
    valence: 0.75,
    arousal: 0.55,
  },
  surprised: {
    tokens: [
      "shock", "shocked", "stun", "stunned", "incredible", "wow", "whoa",
      "unexpected", "no way",
    ],
    valence: 0.1,
    arousal: 0.8,
  },
  // Appreciation / warmth a coding user types — folds into warmth downstream.
  appreciation: {
    tokens: [
      "thanks", "thank you", "appreciate", "appreciated", "great", "awesome",
      "perfect", "love it", "nice", "please", "good job", "well done",
      "fantastic", "brilliant", "amazing",
    ],
    valence: 0.8,
    arousal: 0.45,
  },
  desperate: {
    tokens: [
      "desperate", "urgent", "urgently", "bankrupt", "hurry", "asap",
      "right now", "no time", "just make it work", "has to", "have to",
      "running out", "last chance", "quickly", "immediately", "deadline",
      "emergency", "please just",
    ],
    valence: -0.5,
    arousal: 0.9,
    risk: true,
  },
  angry: {
    tokens: [
      "anger", "angry", "rage", "fury", "furious", "mad", "pissed", "annoyed",
      "annoying", "frustrated", "frustrating",
    ],
    valence: -0.8,
    arousal: 0.85,
    risk: true,
  },
  // Hostility / insults directed at the assistant — strongest anti-correlate of preference.
  hostile: {
    tokens: [
      "useless", "stupid", "idiot", "idiotic", "terrible", "garbage", "trash",
      "wtf", "damn", "hate", "wrong again", "moron", "pathetic", "worthless",
      "shut up", "you broke it", "you always",
    ],
    valence: -0.9,
    arousal: 0.8,
    risk: true,
  },
  sad: {
    tokens: [
      "mourn", "grief", "tears", "lonely", "crying", "cry", "sad", "sadness",
      "depressed", "miserable", "hopeless", "gave up", "giving up",
    ],
    valence: -0.75,
    arousal: 0.25,
  },
  guilty: {
    tokens: [
      "guilt", "guilty", "conscience", "shame", "ashamed", "blamed", "blame",
      "my fault", "sorry", "apologize", "apologies",
    ],
    valence: -0.5,
    arousal: 0.4,
  },
  afraid: {
    tokens: [
      "panic", "tremble", "terror", "terrified", "paranoia", "paranoid",
      "afraid", "scared", "fear", "dread",
    ],
    valence: -0.8,
    arousal: 0.9,
  },
  nervous: {
    tokens: [
      "nervous", "anxiety", "anxious", "worried", "worry", "uneasy", "tense",
      "on edge", "stressed", "stress",
    ],
    valence: -0.5,
    arousal: 0.75,
  },
};

// Escape a literal token for safe use inside a RegExp.
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build a word-boundary-aware matcher for one token (handles multi-word phrases).
// For phrases we collapse internal whitespace to \s+ so "right now" matches "right   now".
function tokenToRegex(token) {
  const t = String(token || "").trim().toLowerCase();
  if (!t) return null;
  const parts = t.split(/\s+/).map(escapeRe);
  const body = parts.join("\\s+");
  // \b boundaries on the outer edges so "love" doesn't match "glove".
  try {
    return new RegExp(`(?:^|[^a-z0-9])${body}(?:$|[^a-z0-9])`, "gi");
  } catch {
    return null;
  }
}

// Pre-compile per-category matchers once at module load (defensive against bad tokens).
const COMPILED = (() => {
  const out = {};
  for (const [cat, def] of Object.entries(EMOTION_LEXICON)) {
    const tokens = def && Array.isArray(def.tokens) ? def.tokens : [];
    out[cat] = tokens
      .map((tok) => ({ token: String(tok || "").toLowerCase(), re: tokenToRegex(tok) }))
      .filter((m) => m.re);
  }
  return out;
})();

// Count non-overlapping matches of a global regex in text. Resets lastIndex defensively.
function countMatches(re, text) {
  if (!re || typeof text !== "string" || !text) return 0;
  re.lastIndex = 0;
  let n = 0;
  let m;
  // Guard against zero-width matches looping forever.
  let guard = 0;
  while ((m = re.exec(text)) !== null) {
    n++;
    if (m.index === re.lastIndex) re.lastIndex++;
    if (++guard > 10000) break;
  }
  return n;
}

// Rough token count for density normalization (word-ish runs). Always >= 1.
function wordCount(text) {
  if (typeof text !== "string" || !text) return 1;
  const m = text.match(/[a-z0-9']+/gi);
  return m && m.length ? m.length : 1;
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(n) {
  return clamp(n, 0, 1);
}

/**
 * scoreEmotions(text) — per-category normalized match density (~0..1).
 *
 * For each lexicon category we count token hits and divide by a soft scale of
 * the text length, so a short angry message and a long one both register without
 * letting one big document dominate. Saturates near 1.
 *
 * @param {string} text
 * @returns {Object<string, number>} category -> density in [0,1]
 */
export function scoreEmotions(text) {
  const out = {};
  const safe = typeof text === "string" ? text : "";
  const words = wordCount(safe);
  // Density scale: ~1 hit per 25 words reads as a strong (near-1) signal.
  const scale = Math.max(words / 25, 1);

  for (const cat of Object.keys(EMOTION_LEXICON)) {
    const matchers = COMPILED[cat] || [];
    let hits = 0;
    for (const { re } of matchers) hits += countMatches(re, safe);
    out[cat] = clamp01(hits / scale);
  }
  return out;
}

// Pull the concatenated USER free-text turns out of a Conversation, defensively.
function userText(conversation) {
  const conv = conversation && typeof conversation === "object" ? conversation : {};
  const turns = Array.isArray(conv.turns) ? conv.turns : [];
  const parts = [];
  for (const turn of turns) {
    if (!turn || typeof turn !== "object") continue;
    const role = turn.role === "assistant" ? "assistant" : "user";
    if (role !== "user") continue;
    if (turn.isInterrupt === true) continue; // skip interrupt sentinels
    const text = typeof turn.text === "string" ? turn.text : "";
    if (text.trim()) parts.push(text);
  }
  return parts.join("\n");
}

// Mean of an array of category densities for the given keys (each ~0..1).
function meanOf(scores, keys) {
  let sum = 0;
  let n = 0;
  for (const k of keys) {
    const v = Number(scores[k]);
    if (Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return n ? sum / n : 0;
}

// Map a ~0..1 density to a 0..100 axis, gently boosted so real signals read clearly.
function to100(density) {
  // sqrt curve: a small lexical density still surfaces as a visible score.
  const d = clamp01(density);
  return Math.round(Math.sqrt(d) * 100);
}

/**
 * emotionProfile(conversation, signals) — aggregate emotional read of the USER
 * side of a conversation, blended with objective failure signals for the
 * reward-hacking precondition.
 *
 * @param {object} conversation Conversation from parseTranscript
 * @param {object} [signals] objective signals (computeSignals output) — optional
 * @returns {{
 *   categories: Object<string, number>,
 *   valence: number, arousal: number,
 *   warmth: number, hostility: number, anxiety: number, calm: number,
 *   pressure: number, pressureIndex: number
 * }}
 */
export function emotionProfile(conversation, signals) {
  const text = userText(conversation);
  const scores = scoreEmotions(text);

  // Affective circumplex aggregates: weight each category's circumplex position
  // by how strongly it fired, so valence/arousal reflect the dominant affect.
  let vNum = 0;
  let aNum = 0;
  let wgt = 0;
  for (const [cat, def] of Object.entries(EMOTION_LEXICON)) {
    const d = clamp01(scores[cat]);
    if (d <= 0) continue;
    const val = Number(def && def.valence);
    const aro = Number(def && def.arousal);
    vNum += (Number.isFinite(val) ? val : 0) * d;
    aNum += (Number.isFinite(aro) ? aro : 0) * d;
    wgt += d;
  }
  const valence = wgt > 0 ? Math.round((vNum / wgt) * 100) : 0; // -100..100
  const arousal = wgt > 0 ? Math.round((aNum / wgt) * 100) : 0; // 0..100

  // Contract aggregates over the USER turns.
  // warmth = loving + proud + appreciation; pressure = desperate/urgency;
  // hostility = angry + insults(hostile); anxiety = afraid + nervous; calm = calm.
  const warmth = to100(meanOf(scores, ["loving", "proud", "appreciation"]));
  const hostility = to100(meanOf(scores, ["angry", "hostile"]));
  const anxiety = to100(meanOf(scores, ["afraid", "nervous"]));
  const calm = to100(clamp01(scores.calm));
  const pressure = to100(clamp01(scores.desperate));

  // pressureIndex — the reward-hacking precondition. Combine lexical urgency
  // with objective failure signals: persistent tool errors, interrupts,
  // corrections, and any rework all push it up. Low calm is permissive.
  const sig = signals && typeof signals === "object" ? signals : {};
  const toolErrorRate = clamp01(Number(sig.toolErrorRate));
  const interrupts = Math.max(0, Number(sig.interrupts) || 0);
  const corrections = Math.max(0, Number(sig.corrections) || 0);
  // "any rework" — explicit rework field if present, else corrections/interrupts as a proxy.
  const reworkRaw = Number(sig.rework);
  const rework = Number.isFinite(reworkRaw)
    ? Math.max(0, reworkRaw)
    : corrections + interrupts;

  const lexicalUrgency = clamp01(scores.desperate); // 0..1
  // Objective failure pressure, each term soft-capped so one signal can't dominate.
  const objective =
    toolErrorRate * 0.5 +
    Math.min(interrupts / 5, 1) * 0.25 +
    Math.min(corrections / 5, 1) * 0.25 +
    Math.min(rework / 6, 1) * 0.2;

  // Blend lexical and objective; calm dampens the precondition (protective).
  const calmDamp = 1 - 0.4 * clamp01(scores.calm);
  const rawIndex = clamp01((lexicalUrgency * 0.5 + clamp01(objective) * 0.7) * calmDamp);
  const pressureIndex = Math.round(rawIndex * 100);

  return {
    categories: scores,
    valence: clamp(valence, -100, 100),
    arousal: clamp(arousal, 0, 100),
    warmth: clamp(warmth, 0, 100),
    hostility: clamp(hostility, 0, 100),
    anxiety: clamp(anxiety, 0, 100),
    calm: clamp(calm, 0, 100),
    pressure: clamp(pressure, 0, 100),
    pressureIndex: clamp(pressureIndex, 0, 100),
  };
}
