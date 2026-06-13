#!/usr/bin/env node
// bin/aihappiness.js — CLI for aihappiness: scan | analyze | report | dashboard (default: analyze then dashboard)
import fs from 'node:fs';
import path from 'node:path';
import { scanTranscripts } from '../src/scan.js';
import { buildReport } from '../src/report.js';
import { detectEngine } from '../src/engine.js';
import { startDashboard } from '../src/server.js';

// ---------- tiny ANSI color helpers (no deps; respect NO_COLOR / non-TTY) ----------
const COLOR_ON = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (COLOR_ON ? `[${code}m${s}[0m` : String(s));
const bold = c('1');
const dim = c('2');
const red = c('31');
const green = c('32');
const yellow = c('33');
const blue = c('34');
const magenta = c('35');
const cyan = c('36');

// ASCII face by score bucket (terminal/limbic aesthetic)
function face(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return ':|';
  if (s >= 80) return ':D';
  if (s >= 65) return ':)';
  if (s >= 50) return ':|';
  if (s >= 35) return ':/';
  return ':(';
}

// the 6 happiness dimensions mapped onto their limbic structure + a color
const DIMS = [
  { key: 'affectiveValence',           label: 'Affective Valence',  struct: 'Amygdala',               color: yellow },
  { key: 'autonomyRespect',            label: 'Autonomy & Respect', struct: 'Anterior Cingulate',     color: magenta },
  { key: 'psychologicalSafety',        label: 'Psych. Safety',      struct: 'Hypothalamus',           color: cyan },
  { key: 'flowEngagement',             label: 'Flow & Engagement',  struct: 'Nucleus Accumbens',      color: c('38;5;209') },
  { key: 'competenceFlowVsStrain',     label: 'Competence/Strain',  struct: 'Hippocampus',            color: blue },
  { key: 'goalCompletionSatisfaction', label: 'Goal Completion',    struct: 'Ventral Tegmental Area', color: green },
];

// block-element progress bar for a 0..100 score
function bar(score, width = 20) {
  const v = Math.max(0, Math.min(100, Number(score) || 0));
  const n = Math.round((width * v) / 100);
  return '▇'.repeat(n) + dim('░'.repeat(Math.max(0, width - n)));
}

// little ASCII limbic brain for the banner
const BRAIN = [
  '   .-~~~-.   ',
  ' .-~ _**_ ~-.',
  '(  ( (  ) )  )',
  ' \'-.~~~~~.-\' ',
  '    \'~-~\'    ',
];

// color a 0..100 score
function colorScore(score) {
  const s = Number(score);
  const txt = Number.isFinite(s) ? s.toFixed(1) : '—';
  if (!Number.isFinite(s)) return dim(txt);
  if (s >= 80) return green(txt);
  if (s >= 65) return cyan(txt);
  if (s >= 50) return yellow(txt);
  if (s >= 35) return magenta(txt);
  return red(txt);
}

function truncate(str, n) {
  const s = String(str == null ? '' : str);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------- flag parsing ----------
function parseArgs(argv) {
  const args = { _: [] };
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const take = () => list[++i];
    switch (a) {
      case '--limit': args.limit = parseInt(take(), 10); break;
      case '--project': args.project = take(); break;
      case '--engine': args.engine = take(); break;
      case '--model': args.model = take(); break;
      case '--port': args.port = parseInt(take(), 10); break;
      case '--root': args.root = take(); break;
      case '-h':
      case '--help': args.help = true; break;
      default:
        if (a && a.startsWith('--')) {
          // tolerate --flag=value
          const eq = a.indexOf('=');
          if (eq !== -1) {
            const key = a.slice(2, eq);
            const val = a.slice(eq + 1);
            if (key === 'limit' || key === 'port') args[key] = parseInt(val, 10);
            else args[key] = val;
          }
        } else {
          args._.push(a);
        }
    }
  }
  return args;
}

function printHelp() {
  const lines = [
    bold('aihappiness') + dim(' — score how happy Claude is in your conversations'),
    '',
    bold('Usage:') + '  aihappiness [command] [flags]',
    '',
    bold('Commands:'),
    '  ' + cyan('scan') + '       List discovered Claude Code conversations',
    '  ' + cyan('analyze') + '    Analyze conversations, write report.json, print a summary',
    '  ' + cyan('report') + '     Print the summary from an existing report.json',
    '  ' + cyan('dashboard') + '  Serve the web dashboard',
    '  ' + dim('(none)') + '     Analyze, then start the dashboard',
    '',
    bold('Flags:'),
    '  --limit N        Max conversations to analyze (newest first)',
    '  --project STR    Filter by substring of the encoded project dir',
    '  --engine E       Force engine: claude | api',
    '  --model STR      Override model id',
    '  --port N         Dashboard port (default 7777)',
    '  --root PATH      Transcripts root (default ~/.claude/projects)',
    '  -h, --help       Show this help'
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

// ---------- live progress line ----------
function makeProgress() {
  let lastLen = 0;
  return {
    update(i, total, title) {
      if (!process.stdout.isTTY) return;
      const pct = total > 0 ? Math.round((i / total) * 100) : 100;
      const width = 24;
      const filled = Math.round((width * (total > 0 ? i / total : 1)));
      const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
      const line = `${cyan(bar)} ${bold(String(pct).padStart(3) + '%')} ${dim(`(${i}/${total})`)} ${truncate(title, 48)}`;
      const plain = line.replace(/\[[0-9;]*m/g, '');
      process.stdout.write('\r' + line + ' '.repeat(Math.max(0, lastLen - plain.length)));
      lastLen = plain.length;
    },
    done() {
      if (!process.stdout.isTTY) return;
      process.stdout.write('\r' + ' '.repeat(lastLen + 2) + '\r');
      lastLen = 0;
    }
  };
}

// plain-English reading of the correlation
function corrPhrase(r, n) {
  if (!Number.isFinite(r)) return 'not enough data';
  const a = Math.abs(r);
  const s = a >= 0.6 ? 'strong' : a >= 0.35 ? 'moderate' : a >= 0.15 ? 'weak' : 'no';
  if (n < 3) return `directional only, n=${n}`;
  if (a < 0.15) return `${s} link, n=${n}`;
  return `${s} ${r > 0 ? 'positive' : 'negative'} link, n=${n}`;
}

// ---------- summary printer ----------
function printSummary(report) {
  if (!report) {
    process.stdout.write(red('No report available.\n'));
    return;
  }
  const t = report.totals || {};
  const convs = Array.isArray(report.conversations) ? report.conversations : [];
  const W = 66; // inner width of the framed banner

  const pad = (s, n) => {
    const plain = String(s).replace(/\x1b\[[0-9;]*m/g, '');
    return s + ' '.repeat(Math.max(0, n - plain.length));
  };
  const row = (s) => process.stdout.write(dim('  │ ') + pad(s, W) + dim('│') + '\n');

  // ---- framed ASCII-brain banner ----
  process.stdout.write('\n' + dim('  ╭' + '─'.repeat(W + 1) + '╮') + '\n');
  const bannerText = [
    bold(magenta('aihappiness')) + dim(' · limbic system monitor'),
    dim(`engine ${report.engine || '?'} · ${report.model || '?'} · n=${t.count ?? convs.length}`),
    '',
    dim('is claude happy?'),
    '',
  ];
  BRAIN.forEach((bl, i) => row(magenta(bl) + '  ' + (bannerText[i] || '')));
  process.stdout.write(dim('  ╰' + '─'.repeat(W + 1) + '╯') + '\n\n');

  // ---- headline scores ----
  const overall = Number(t.avgHappiness);
  process.stdout.write(
    `  ${bold('CLAUDE HAPPINESS')}  ${colorScore(overall)}${dim('/100')}  ${face(overall)}  ${bar(overall, 26)}\n`
  );
  const corr = Number(t.correlation);
  const corrStr = Number.isFinite(corr) ? (corr > 0 ? '+' : '') + corr.toFixed(2) : '—';
  const corrColored = corr > 0.15 ? green(corrStr) : corr < -0.15 ? red(corrStr) : yellow(corrStr);
  const valNum = Number(t.avgValence);
  process.stdout.write(
    `  ${dim('effectiveness')} ${colorScore(t.avgEffectiveness)}` +
    `   ${dim('valence')} ${Number.isFinite(valNum) ? (valNum > 0 ? '+' : '') + valNum.toFixed(0) : '—'}` +
    `   ${dim('corr(happy,eff)')} ${corrColored} ${dim('(' + corrPhrase(corr, t.count ?? convs.length) + ')')}\n`
  );

  if (convs.length === 0) {
    process.stdout.write('\n' + dim('  No conversations analyzed.\n\n'));
    return;
  }

  // ---- limbic map (avg dimension across sessions) ----
  process.stdout.write('\n  ' + bold('LIMBIC MAP') + dim('  avg across sessions') + '\n');
  for (const d of DIMS) {
    const vals = convs.map((c) => Number(c.dimensions && c.dimensions[d.key])).filter(Number.isFinite);
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 50;
    process.stdout.write(
      `  ${dim(d.struct.padEnd(22))} ${d.color(d.label.padEnd(20))} ${bar(avg, 18)} ${colorScore(avg)}\n`
    );
  }

  // ---- per-session lines, happiest first ----
  process.stdout.write('\n  ' + bold('SESSIONS') + '\n');
  const sorted = [...convs].sort((a, b) => (Number(b.happiness) || 0) - (Number(a.happiness) || 0));
  for (const conv of sorted) {
    const h = Number(conv.happiness);
    const e = Number(conv.effectiveness);
    process.stdout.write(
      `  ${face(h)} ${bold(String(Number.isFinite(h) ? h.toFixed(0) : '—').padStart(3))}` +
      ` ${bar(h, 12)} ${dim('eff')} ${String(Number.isFinite(e) ? e.toFixed(0) : '—').padStart(3)}` +
      `  ${truncate(conv.title || conv.sessionId || 'untitled', 40).padEnd(40)}` +
      ` ${dim(truncate(conv.project || '', 18))}\n`
    );
    if (conv.error) {
      process.stdout.write('     ' + red(dim('⚠ ' + truncate(conv.error, 60))) + '\n');
    }
  }
  process.stdout.write('\n');
}

// ---------- commands ----------
async function cmdScan(args) {
  let rows = [];
  try {
    rows = scanTranscripts({ root: args.root, project: args.project }) || [];
  } catch (err) {
    process.stderr.write(red(`scan failed: ${err && err.message ? err.message : err}\n`));
    process.exitCode = 1;
    return;
  }
  rows.sort((a, b) => (b?.mtimeMs || 0) - (a?.mtimeMs || 0));

  process.stdout.write('\n' + bold(`  Found ${rows.length} conversation${rows.length === 1 ? '' : 's'}`) + '\n');
  process.stdout.write(dim('  ' + '─'.repeat(72)) + '\n');
  if (rows.length === 0) {
    process.stdout.write(dim('  Nothing under ' + (args.root || '~/.claude/projects') + '\n\n'));
    return;
  }
  for (const r of rows) {
    const kb = Number.isFinite(Number(r.sizeBytes)) ? (Number(r.sizeBytes) / 1024).toFixed(1) + ' KB' : '?';
    process.stdout.write(
      `  ${cyan(truncate(r.project || '?', 30).padEnd(30))} ` +
      `${dim(truncate(r.sessionId || '?', 36).padEnd(36))} ` +
      `${String(kb).padStart(10)}\n`
    );
  }
  process.stdout.write('\n');
}

async function cmdAnalyze(args) {
  const engine = args.engine || detectEngine();
  process.stdout.write(dim(`\n  Analyzing with engine=${engine}${args.model ? ` model=${args.model}` : ''}…\n`));
  const progress = makeProgress();
  let report;
  try {
    report = await buildReport({
      root: args.root,
      project: args.project,
      limit: args.limit,
      engine,
      model: args.model,
      onProgress: (i, total, title) => progress.update(i, total, title)
    });
  } finally {
    progress.done();
  }
  printSummary(report);
  return report;
}

function cmdReport(args) {
  const reportPath = path.join(process.cwd(), '.aihappiness', 'report.json');
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (err) {
    process.stderr.write(red(`No report found at ${reportPath} — run 'aihappiness analyze' first.\n`));
    process.exitCode = 1;
    return null;
  }
  printSummary(report);
  return report;
}

function cmdDashboard(args) {
  const reportPath = path.join(process.cwd(), '.aihappiness', 'report.json');
  if (!fs.existsSync(reportPath)) {
    process.stderr.write(yellow(`No report at ${reportPath} yet — run 'aihappiness analyze' first (serving anyway).\n`));
  }
  startDashboard({ port: args.port || 7777, reportPath });
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  const command = args._[0];

  switch (command) {
    case 'scan':
      await cmdScan(args);
      break;
    case 'analyze':
      await cmdAnalyze(args);
      break;
    case 'report':
      cmdReport(args);
      break;
    case 'dashboard':
      cmdDashboard(args);
      break;
    case undefined:
      // default: analyze, then start dashboard
      await cmdAnalyze(args);
      cmdDashboard(args);
      break;
    default:
      process.stderr.write(red(`Unknown command: ${command}\n\n`));
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(red(`\naihappiness error: ${err && err.stack ? err.stack : err}\n`));
  process.exitCode = 1;
});
