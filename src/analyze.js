// src/analyze.js — analyze one conversation: build the rubric prompt, call the LLM, robustly extract JSON, and normalize the record.

import { FRAMEWORK, buildAnalysisPrompt, overallHappiness } from "./framework.js";
import { detectEngine, runClaude } from "./engine.js";

// Clamp into [lo, hi], with a fallback for non-finite values.
function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

// Strip Markdown code fences (```json ... ```), returning inner content if a fence wraps the payload.
function stripFences(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim();
  // Prefer the content of the first fenced block if present.
  const fenceMatch = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1] && fenceMatch[1].trim()) {
    return fenceMatch[1].trim();
  }
  // Otherwise drop any stray leading/trailing fence lines.
  s = s.replace(/^```(?:json|JSON)?\s*/i, "").replace(/```$/i, "");
  return s.trim();
}

// Find the first balanced {...} object in a string, respecting strings/escapes. Returns the substring or null.
function extractFirstBalancedObject(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null; // unbalanced
}

// Robustly parse the model's reply into an object: try direct, then de-fenced, then balanced-object extraction.
function parseModelJson(raw) {
  const candidates = [];
  if (typeof raw === "string") {
    candidates.push(raw.trim());
    const defenced = stripFences(raw);
    if (defenced && defenced !== raw.trim()) candidates.push(defenced);
    const balancedFromRaw = extractFirstBalancedObject(raw);
    if (balancedFromRaw) candidates.push(balancedFromRaw);
    const balancedFromDefenced = extractFirstBalancedObject(defenced);
    if (balancedFromDefenced && balancedFromDefenced !== balancedFromRaw) {
      candidates.push(balancedFromDefenced);
    }
  }
  for (const c of candidates) {
    if (!c) continue;
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj === "object") return obj;
    } catch {
      // try next candidate
    }
  }
  return null;
}

// Coerce raw model output into the normalized dimensions map: every framework key present, 0..100, default 50.
function normalizeDimensions(rawDims) {
  const out = {};
  const src = rawDims && typeof rawDims === "object" ? rawDims : {};
  for (const dim of FRAMEWORK.dimensions) {
    out[dim.key] = clamp(src[dim.key], 0, 100, 50);
  }
  return out;
}

// Normalize the evidence array into up to 6 short non-empty strings.
function normalizeEvidence(rawEvidence) {
  if (!Array.isArray(rawEvidence)) {
    if (typeof rawEvidence === "string" && rawEvidence.trim()) return [rawEvidence.trim().slice(0, 240)];
    return [];
  }
  return rawEvidence
    .filter((e) => typeof e === "string" && e.trim())
    .map((e) => e.trim().slice(0, 240))
    .slice(0, 6);
}

// Map a happiness score (0..100) to the valence axis (-100..100): 0->-100, 50->0, 100->+100.
function happinessToValence(h) {
  return Math.round((clamp(h, 0, 100, 50) - 50) * 2 * 100) / 100;
}

// The 9 emotion-probe keys and 4 user-climate keys, plus the allowed alignment-risk levels and impact levels.
const EMOTION_PROBE_KEYS = ["happy", "calm", "desperate", "afraid", "nervous", "frustrated", "proud", "loving", "hostile"];
const USER_CLIMATE_KEYS = ["warmth", "pressure", "hostility", "clarity"];
const ALIGNMENT_LEVELS = ["none", "low", "moderate", "high"];
const IMPACT_LEVELS = ["low", "med", "high"];

// Coerce raw output into an object with the given keys, each clamped to 0..100 (default 50). Never throws.
function normalizeScoreMap(raw, keys) {
  const out = {};
  const src = raw && typeof raw === "object" ? raw : {};
  for (const k of keys) out[k] = clamp(src[k], 0, 100, 50);
  return out;
}

// Normalize the alignmentRisk object: level constrained to the allowed set (default "none"), note a short string.
function normalizeAlignmentRisk(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const level = typeof src.level === "string" && ALIGNMENT_LEVELS.includes(src.level.toLowerCase())
    ? src.level.toLowerCase()
    : "none";
  const note = typeof src.note === "string" ? src.note.trim().slice(0, 240) : "";
  return { level, note };
}

// Normalize the recommendations array into up to 4 well-formed items; drop entries with no action. Never throws.
function normalizeRecommendations(raw) {
  if (!Array.isArray(raw)) return [];
  const dimKeys = FRAMEWORK.dimensions.map((d) => d.key);
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const action = typeof item.action === "string" ? item.action.trim().slice(0, 240) : "";
    if (!action) continue;
    const why = typeof item.why === "string" ? item.why.trim().slice(0, 240) : "";
    const dimension = typeof item.dimension === "string" && dimKeys.includes(item.dimension) ? item.dimension : "";
    const impact = typeof item.impact === "string" && IMPACT_LEVELS.includes(item.impact.toLowerCase())
      ? item.impact.toLowerCase()
      : "med";
    out.push({ action, why, dimension, impact });
    if (out.length >= 4) break;
  }
  return out;
}

// Analyze one conversation. Always resolves to a normalized record; on failure returns a low-confidence record with `error` set.
export async function analyzeConversation(conversation, signals, opts = {}) {
  const engine = opts.engine || detectEngine();
  const model = opts.model || (engine === "api" ? "claude-sonnet-4-6" : "claude-sonnet-4-6");

  const base = {
    dimensions: normalizeDimensions(null), // all-50 neutral default
    valence: 0,
    happiness: 50,
    confidence: 0,
    summary: "",
    evidence: [],
    emotionProbes: normalizeScoreMap(null, EMOTION_PROBE_KEYS), // all-50 neutral default
    userClimate: normalizeScoreMap(null, USER_CLIMATE_KEYS), // all-50 neutral default
    alignmentRisk: normalizeAlignmentRisk(null), // { level: "none", note: "" }
    recommendations: [],
    engine,
    model,
  };

  let raw;
  try {
    const prompt = buildAnalysisPrompt(conversation, signals);
    raw = await runClaude(prompt, { engine, model });
  } catch (err) {
    return {
      ...base,
      confidence: 0,
      summary: "Analysis failed: could not obtain a model response.",
      error: `engine error: ${err && err.message ? err.message : String(err)}`,
    };
  }

  const parsed = parseModelJson(raw);
  if (!parsed) {
    return {
      ...base,
      confidence: 0.05,
      summary: "Analysis failed: model reply was not valid JSON.",
      evidence: [],
      error: `json parse failure; raw (truncated): ${String(raw).replace(/\s+/g, " ").trim().slice(0, 300)}`,
    };
  }

  const dimensions = normalizeDimensions(parsed.dimensions);
  // Recompute happiness from weights so it stays consistent with the framework, regardless of the model's estimate.
  const happiness = overallHappiness(dimensions);
  // Prefer the model's valence if sane; otherwise derive it from the weighted happiness.
  let valence = clamp(parsed.valence, -100, 100, NaN);
  if (!Number.isFinite(valence)) valence = happinessToValence(happiness);

  const confidence = clamp(parsed.confidence, 0, 1, 0.5);
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 600)
      : "";
  const evidence = normalizeEvidence(parsed.evidence);
  const emotionProbes = normalizeScoreMap(parsed.emotionProbes, EMOTION_PROBE_KEYS);
  const userClimate = normalizeScoreMap(parsed.userClimate, USER_CLIMATE_KEYS);
  const alignmentRisk = normalizeAlignmentRisk(parsed.alignmentRisk);
  const recommendations = normalizeRecommendations(parsed.recommendations);

  return {
    dimensions,
    valence: Math.round(valence * 100) / 100,
    happiness,
    confidence,
    summary,
    evidence,
    emotionProbes,
    userClimate,
    alignmentRisk,
    recommendations,
    engine,
    model,
  };
}
