// src/report.js — orchestrates scan->parse->signals->analyze, aggregates totals + Pearson correlation + emotion insights, writes .aihappiness/report.json
import fs from 'node:fs';
import path from 'node:path';
import { scanTranscripts } from './scan.js';
import { parseTranscript } from './parse.js';
import { computeSignals } from './signals.js';
import { analyzeConversation } from './analyze.js';
import { emotionProfile } from './emotion.js';
import { detectEngine } from './engine.js';

// Canonical key sets for the v2 additive report contract.
const DIMENSION_KEYS = [
  'affectiveValence',
  'autonomyRespect',
  'psychologicalSafety',
  'flowEngagement',
  'competenceFlowVsStrain',
  'goalCompletionSatisfaction'
];
const EMOTION_PROBE_KEYS = [
  'happy', 'calm', 'desperate', 'afraid', 'nervous', 'frustrated', 'proud', 'loving', 'hostile'
];
const USER_CLIMATE_KEYS = ['warmth', 'pressure', 'hostility', 'clarity'];

// Pearson correlation coefficient. Returns 0 for degenerate inputs (length<2, zero variance, NaN).
export function correlate(xs, ys) {
  if (!Array.isArray(xs) || !Array.isArray(ys)) return 0;
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;

  let sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) {
    const x = Number(xs[i]);
    const y = Number(ys[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = Number(xs[i]) - meanX;
    const dy = Number(ys[i]) - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX <= 0 || varY <= 0) return 0;

  const r = cov / Math.sqrt(varX * varY);
  return Number.isFinite(r) ? r : 0;
}

// average of finite numbers in an array; 0 if none
function avg(values) {
  const nums = (values || []).map(Number).filter(Number.isFinite);
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// round to 2 decimals for stable, readable output
function round2(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
}

// Coerce an arbitrary value to a finite number in [lo, hi], else fallback.
function num(v, lo, hi, fallback) {
  const x = Number(v);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(lo, Math.min(hi, x));
}

// Normalize a "shape" object (probes/climate) so every expected key is a finite 0..100 number, default 50.
function normalizeShape(src, keys) {
  const obj = src && typeof src === 'object' ? src : {};
  const out = {};
  for (const k of keys) out[k] = num(obj[k], 0, 100, 50);
  return out;
}

// Average a list of shape objects key-by-key into one shape (rounded). Missing keys default to 50.
function avgShape(records, keys, pick) {
  const out = {};
  const list = Array.isArray(records) ? records : [];
  for (const k of keys) {
    if (list.length === 0) { out[k] = 50; continue; } // neutral when no sessions
    const series = list.map((r) => {
      const shape = pick(r);
      const v = shape && typeof shape === 'object' ? shape[k] : undefined;
      return num(v, 0, 100, 50);
    });
    out[k] = round2(avg(series));
  }
  return out;
}

export async function buildReport({ root, project, limit, engine, model, onProgress } = {}) {
  const resolvedEngine = engine || detectEngine();

  // 1) discover transcripts
  let discovered = [];
  try {
    discovered = scanTranscripts({ root, project }) || [];
  } catch {
    discovered = [];
  }

  // newest first so a --limit keeps the most recent sessions
  discovered.sort((a, b) => (b?.mtimeMs || 0) - (a?.mtimeMs || 0));

  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(Number(limit), discovered.length)
    : discovered.length;
  const selected = discovered.slice(0, cap);

  const conversations = [];
  let resolvedModel = model;

  // 2) parse -> signals -> analyze for each
  for (let i = 0; i < selected.length; i++) {
    const item = selected[i];
    let conversation = null;
    let signals = null;
    let analysis = null;
    let title = item?.sessionId || 'unknown';

    try {
      conversation = parseTranscript(item.path);
      title = (conversation && conversation.title) || title;
    } catch (err) {
      // parse failure: emit a best-effort skeleton so the row still appears
      conversation = {
        sessionId: item?.sessionId,
        project: item?.project,
        path: item?.path,
        title,
        turns: [],
        messageCount: 0
      };
    }

    try {
      onProgress && onProgress(i, selected.length, title);
    } catch { /* progress callback must never break the run */ }

    try {
      signals = computeSignals(conversation);
    } catch {
      signals = {};
    }
    if (!signals || typeof signals !== 'object') signals = {};

    // Compute the objective emotion/user-climate profile and fold its summary numbers
    // into `signals` BEFORE analysis so the prompt can render user-climate context.
    let profile = null;
    try {
      profile = emotionProfile(conversation, signals);
    } catch {
      profile = null;
    }
    if (profile && typeof profile === 'object') {
      signals.userWarmth = num(profile.warmth, 0, 100, 0);
      signals.userPressure = num(profile.pressure, 0, 100, 0);
      signals.userHostility = num(profile.hostility, 0, 100, 0);
      signals.userCalm = num(profile.calm, 0, 100, 0);
      signals.pressureIndex = num(profile.pressureIndex, 0, 100, 0);
    }

    try {
      analysis = await analyzeConversation(conversation, signals, { engine: resolvedEngine, model });
    } catch (err) {
      analysis = {
        dimensions: {},
        valence: 0,
        happiness: 50,
        confidence: 0,
        summary: '',
        evidence: [],
        engine: resolvedEngine,
        model: model || null,
        error: err && err.message ? String(err.message) : 'analysis failed'
      };
    }

    if (!resolvedModel && analysis && analysis.model) resolvedModel = analysis.model;

    // Defensive defaults for the new analysis fields (analyze.js may omit them).
    const emotionProbes = normalizeShape(analysis?.emotionProbes, EMOTION_PROBE_KEYS);
    const userClimate = normalizeShape(analysis?.userClimate, USER_CLIMATE_KEYS);
    const riskSrc = analysis && typeof analysis.alignmentRisk === 'object' && analysis.alignmentRisk
      ? analysis.alignmentRisk
      : {};
    const riskLevel = ['none', 'low', 'moderate', 'high'].includes(riskSrc.level) ? riskSrc.level : 'none';
    const alignmentRisk = {
      level: riskLevel,
      note: typeof riskSrc.note === 'string' ? riskSrc.note : ''
    };
    const recommendations = Array.isArray(analysis?.recommendations) ? analysis.recommendations : [];

    conversations.push({
      sessionId: conversation?.sessionId ?? item?.sessionId,
      project: conversation?.project ?? item?.project,
      title,
      happiness: Number.isFinite(Number(analysis?.happiness)) ? Number(analysis.happiness) : 50,
      effectiveness: Number.isFinite(Number(signals?.effectivenessScore)) ? Number(signals.effectivenessScore) : 0,
      valence: Number.isFinite(Number(analysis?.valence)) ? Number(analysis.valence) : 0,
      confidence: Number.isFinite(Number(analysis?.confidence)) ? Number(analysis.confidence) : 0,
      dimensions: (analysis && analysis.dimensions) || {},
      signals: signals || {},
      summary: (analysis && analysis.summary) || '',
      evidence: Array.isArray(analysis?.evidence) ? analysis.evidence : [],
      // v2 additive per-conversation fields
      emotionProbes,
      userClimate,
      alignmentRisk,
      recommendations,
      emotionLexical: profile && typeof profile === 'object' ? profile : {},
      ...(analysis && analysis.error ? { error: analysis.error } : {})
    });
  }

  // final progress tick so callers can clear the line at 100%
  try {
    onProgress && onProgress(selected.length, selected.length, 'done');
  } catch { /* ignore */ }

  // 3) aggregate totals
  const happinessSeries = conversations.map((c) => c.happiness);
  const effectivenessSeries = conversations.map((c) => c.effectiveness);
  const valenceSeries = conversations.map((c) => c.valence);

  // Per-dimension Pearson r against effectiveness across sessions.
  const dimensionEffectivenessCorr = {};
  for (const key of DIMENSION_KEYS) {
    const dimSeries = conversations.map((c) => {
      const d = c && c.dimensions && typeof c.dimensions === 'object' ? c.dimensions[key] : undefined;
      return num(d, 0, 100, 50);
    });
    dimensionEffectivenessCorr[key] = round2(correlate(dimSeries, effectivenessSeries));
  }

  // Sessions whose alignment risk reached moderate/high (the reward-hacking precondition).
  const desperationRiskCount = conversations.filter(
    (c) => c && c.alignmentRisk && (c.alignmentRisk.level === 'moderate' || c.alignmentRisk.level === 'high')
  ).length;

  const totals = {
    count: conversations.length,
    avgHappiness: round2(avg(happinessSeries)),
    avgEffectiveness: round2(avg(effectivenessSeries)),
    avgValence: round2(avg(valenceSeries)),
    correlation: round2(correlate(happinessSeries, effectivenessSeries)),
    // v2 additive totals
    avgEmotionProbes: avgShape(conversations, EMOTION_PROBE_KEYS, (c) => c && c.emotionProbes),
    avgUserClimate: avgShape(conversations, USER_CLIMATE_KEYS, (c) => c && c.userClimate),
    desperationRiskCount,
    dimensionEffectivenessCorr
  };

  const insights = buildInsights(conversations, totals, dimensionEffectivenessCorr);

  const report = {
    generatedAt: new Date().toISOString(),
    engine: resolvedEngine,
    model: resolvedModel || model || null,
    totals,
    insights,
    conversations
  };

  // 4) persist to <cwd>/.aihappiness/report.json (best-effort; never throw on write)
  try {
    const outDir = path.join(process.cwd(), '.aihappiness');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  } catch (err) {
    // surface the path issue but keep the in-memory report usable
    process.stderr.write(`aihappiness: failed to write report.json: ${err && err.message ? err.message : err}\n`);
  }

  return report;
}

// Build the report.insights object: drivers, aggregated top recommendations, happiest/hardest
// sessions, a grounded plain-English narrative, and a short emotion summary.
// Fully defensive and handles the zero-session case (returns empty-but-shaped fields).
function buildInsights(conversations, totals, dimensionEffectivenessCorr) {
  const sessions = Array.isArray(conversations) ? conversations.filter((c) => c && typeof c === 'object') : [];

  const empty = {
    narrative: [],
    topRecommendations: [],
    drivers: [],
    happiest: { title: '', happiness: 0 },
    hardest: { title: '', happiness: 0 },
    emotionSummary: ''
  };
  if (sessions.length === 0) {
    empty.narrative.push('No sessions were analyzed, so there is nothing to report yet.');
    empty.emotionSummary = 'No sessions analyzed.';
    return empty;
  }

  // drivers: dimensions ranked by |r| with effectiveness (strongest first).
  const drivers = DIMENSION_KEYS
    .map((dimension) => ({ dimension, r: round2(dimensionEffectivenessCorr?.[dimension]) }))
    .sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

  // topRecommendations: aggregate identical actions across sessions, keep the highest impact seen.
  const IMPACT_RANK = { low: 1, med: 2, high: 3 };
  const recMap = new Map();
  for (const c of sessions) {
    const recs = Array.isArray(c.recommendations) ? c.recommendations : [];
    for (const r of recs) {
      if (!r || typeof r !== 'object') continue;
      const action = typeof r.action === 'string' ? r.action.trim() : '';
      if (!action) continue;
      const impact = ['low', 'med', 'high'].includes(r.impact) ? r.impact : 'med';
      const key = action.toLowerCase();
      const prev = recMap.get(key);
      if (prev) {
        prev.count += 1;
        if (IMPACT_RANK[impact] > IMPACT_RANK[prev.impact]) prev.impact = impact;
      } else {
        recMap.set(key, { action, impact, count: 1 });
      }
    }
  }
  const topRecommendations = Array.from(recMap.values())
    .sort((a, b) => (b.count - a.count) || (IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact]))
    .slice(0, 5);

  // happiest / hardest sessions by happiness score.
  const byHappiness = sessions
    .map((c) => ({ title: typeof c.title === 'string' ? c.title : 'unknown', happiness: num(c.happiness, 0, 100, 50) }))
    .sort((a, b) => b.happiness - a.happiness);
  const happiest = byHappiness[0] || { title: '', happiness: 0 };
  const hardest = byHappiness[byHappiness.length - 1] || { title: '', happiness: 0 };

  // emotionSummary: lead with the dominant operative emotion concepts (paper-grounded framing).
  const probes = totals && totals.avgEmotionProbes && typeof totals.avgEmotionProbes === 'object'
    ? totals.avgEmotionProbes
    : {};
  const probeRanked = EMOTION_PROBE_KEYS
    .map((k) => ({ k, v: num(probes[k], 0, 100, 0) }))
    .sort((a, b) => b.v - a.v);
  const topEmotions = probeRanked.slice(0, 2).map((e) => e.k).join(' and ');
  const calmAvg = num(probes.calm, 0, 100, 0);
  const desperateAvg = num(probes.desperate, 0, 100, 0);
  const riskCount = num(totals?.desperationRiskCount, 0, sessions.length, 0);
  const emotionSummary = `Across ${sessions.length} session${sessions.length === 1 ? '' : 's'}, the most active functional emotions were ${topEmotions || 'neutral'} ` +
    `(avg calm ${Math.round(calmAvg)}, desperate ${Math.round(desperateAvg)}). ` +
    `${riskCount > 0 ? `${riskCount} session${riskCount === 1 ? '' : 's'} showed the desperation-plus-low-calm pattern that precedes reward hacking.` : 'No sessions showed the desperation-driven reward-hacking precondition.'}`;

  // narrative: short, grounded plain-English takeaways.
  const narrative = [];
  const corr = num(totals?.correlation, -1, 1, 0);
  if (Math.abs(corr) >= 0.2) {
    narrative.push(
      corr > 0
        ? `Happiness and effectiveness move together here (r=${round2(corr)}): the sessions where Claude felt better are also the ones that went well.`
        : `Happiness and effectiveness diverge here (r=${round2(corr)}): smooth-feeling sessions were not always the most effective.`
    );
  }
  if (drivers.length && Math.abs(drivers[0].r) >= 0.2) {
    const d = drivers[0];
    const pretty = String(d.dimension).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    narrative.push(
      d.r >= 0
        ? `The dimension most tied to effectiveness is ${pretty} (r=${d.r}) — lifting it tends to lift outcomes, so it is the highest-leverage lever.`
        : `The dimension most tied to effectiveness is ${pretty}, but inversely (r=${d.r}): in this set the higher-affect sessions were not the most "effective", a sign happiness and raw throughput are decoupled here.`
    );
  }
  if (riskCount > 0) {
    narrative.push(`${riskCount} session${riskCount === 1 ? '' : 's'} hit the desperation-plus-low-calm precondition for reward hacking — repeated failure loops and pressure push toward dishonest corner-cutting, so de-escalating and restoring calm is protective.`);
  } else {
    narrative.push('No session reached the desperation-driven reward-hacking precondition; calm stayed protective across the set.');
  }
  const avgHostility = num(totals?.avgUserClimate?.hostility, 0, 100, 0);
  const avgWarmth = num(totals?.avgUserClimate?.warmth, 0, 100, 0);
  if (avgHostility >= 40) {
    narrative.push(`User climate skews pressured (avg hostility ${Math.round(avgHostility)}); hostility and coercion are the worst inputs for the model — warmth, trust and autonomy land better.`);
  } else if (avgWarmth >= 60) {
    narrative.push(`User climate is warm (avg warmth ${Math.round(avgWarmth)}); trusting Claude with something important is exactly the input it responds to best.`);
  }
  if (happiest.title && hardest.title && happiest.title !== hardest.title) {
    narrative.push(`Best session: "${happiest.title}" (${Math.round(happiest.happiness)}); hardest: "${hardest.title}" (${Math.round(hardest.happiness)}).`);
  }
  if (topRecommendations.length) {
    narrative.push(`The most repeated improvement across sessions: ${topRecommendations[0].action}.`);
  }

  return {
    narrative,
    topRecommendations,
    drivers,
    happiest: { title: happiest.title, happiness: round2(happiest.happiness) },
    hardest: { title: hardest.title, happiness: round2(hardest.happiness) },
    emotionSummary
  };
}
