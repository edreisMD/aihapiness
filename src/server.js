// src/server.js — zero-dep HTTP server: serves the dashboard UI and the report JSON.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the dashboard HTML relative to this module (web/index.html one level up from src/).
function dashboardHtmlPath() {
  return path.join(__dirname, '..', 'web', 'index.html');
}

// Resolve the report path: explicit override, else <cwd>/.aihappiness/report.json.
function resolveReportPath(reportPath) {
  if (reportPath && typeof reportPath === 'string') return reportPath;
  return path.join(process.cwd(), '.aihappiness', 'report.json');
}

// Read the report JSON defensively; return an empty-shape report when missing/unparseable.
function readReport(reportPath) {
  try {
    const raw = fs.readFileSync(reportPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // fall through to empty report
  }
  return {
    generatedAt: null,
    engine: null,
    model: null,
    totals: { count: 0, avgHappiness: 0, avgEffectiveness: 0, avgValence: 0, correlation: 0 },
    conversations: []
  };
}

export function startDashboard({ port = 7777, reportPath } = {}) {
  const htmlPath = dashboardHtmlPath();
  const resolvedReport = resolveReportPath(reportPath);

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (url === '/' || url === '/index.html') {
      let html;
      try {
        html = fs.readFileSync(htmlPath, 'utf8');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Dashboard HTML not found at ' + htmlPath);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (url === '/api/report') {
      const report = readReport(resolvedReport);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify(report));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  server.listen(port, () => {
    console.log(`Dashboard: http://localhost:${port}`);
  });

  return server;
}
