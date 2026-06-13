// src/report.js — orchestrates scan->parse->signals->analyze, aggregates totals + Pearson correlation, writes .aihappiness/report.json
import fs from 'node:fs';
import path from 'node:path';
import { scanTranscripts } from './scan.js';
import { parseTranscript } from './parse.js';
import { computeSignals } from './signals.js';
import { analyzeConversation } from './analyze.js';
import { detectEngine } from './engine.js';

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

  const totals = {
    count: conversations.length,
    avgHappiness: round2(avg(happinessSeries)),
    avgEffectiveness: round2(avg(effectivenessSeries)),
    avgValence: round2(avg(valenceSeries)),
    correlation: round2(correlate(happinessSeries, effectivenessSeries))
  };

  const report = {
    generatedAt: new Date().toISOString(),
    engine: resolvedEngine,
    model: resolvedModel || model || null,
    totals,
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
