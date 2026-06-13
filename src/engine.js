// src/engine.js — LLM transport: pick the 'claude' CLI vs the Anthropic API, and run a prompt to get the raw model text.

import { spawn } from "node:child_process";

// Choose the engine: 'api' when an ANTHROPIC_API_KEY is present, otherwise the local 'claude' CLI.
export function detectEngine() {
  const key = process.env.ANTHROPIC_API_KEY;
  return key && String(key).trim() ? "api" : "claude";
}

// Default models per engine.
const DEFAULT_CLI_MODEL = "claude-sonnet-4-6";
const DEFAULT_API_MODEL = "claude-sonnet-4-6";

// Run the prompt through the chosen engine and return the RAW model text. Throws a clear Error on failure.
export async function runClaude(prompt, { engine, model } = {}) {
  const eng = engine || detectEngine();
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("runClaude: prompt must be a non-empty string");
  }
  if (eng === "api") {
    return runViaApi(prompt, model || DEFAULT_API_MODEL);
  }
  return runViaCli(prompt, model || DEFAULT_CLI_MODEL);
}

// Spawn the 'claude' CLI in headless JSON mode, feed the prompt over stdin, parse stdout JSON, return .result.
function runViaCli(prompt, model) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--model", model];
    // Strip nested-session markers so `aihappiness` can run from inside a Claude Code
    // session (the CLI otherwise refuses to launch nested). Harmless in a plain shell.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_SSE_PORT;
    let child;
    try {
      child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], env });
    } catch (err) {
      reject(new Error(`runClaude(claude CLI): failed to spawn 'claude': ${err && err.message ? err.message : err}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      finish(reject, new Error(`runClaude(claude CLI): process error: ${err && err.message ? err.message : err}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        finish(
          reject,
          new Error(
            `runClaude(claude CLI): exited with code ${code}. stderr: ${truncateErr(stderr)}`
          )
        );
        return;
      }
      // Parse the CLI's JSON envelope and pull out .result (the model's text).
      try {
        const trimmed = stdout.trim();
        if (!trimmed) {
          finish(reject, new Error("runClaude(claude CLI): empty stdout"));
          return;
        }
        const parsed = JSON.parse(trimmed);
        const result = extractCliResult(parsed);
        if (typeof result !== "string") {
          finish(
            reject,
            new Error(
              `runClaude(claude CLI): could not find a string .result in CLI output: ${truncateErr(trimmed)}`
            )
          );
          return;
        }
        finish(resolve, result);
      } catch (err) {
        finish(
          reject,
          new Error(
            `runClaude(claude CLI): failed to parse CLI JSON: ${err && err.message ? err.message : err}. Raw: ${truncateErr(stdout)}`
          )
        );
      }
    });

    // Write the prompt to stdin and close it.
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      finish(reject, new Error(`runClaude(claude CLI): failed writing stdin: ${err && err.message ? err.message : err}`));
    }
  });
}

// The CLI JSON envelope normally has a top-level .result string; be defensive about shape drift.
function extractCliResult(parsed) {
  if (parsed == null) return undefined;
  if (typeof parsed === "string") return parsed;
  if (typeof parsed.result === "string") return parsed.result;
  // Some versions may nest the text differently; try a few known fallbacks.
  if (parsed.message && typeof parsed.message === "string") return parsed.message;
  if (Array.isArray(parsed.content)) {
    const textBlock = parsed.content.find((b) => b && b.type === "text" && typeof b.text === "string");
    if (textBlock) return textBlock.text;
  }
  if (typeof parsed.text === "string") return parsed.text;
  return undefined;
}

// POST to the Anthropic Messages API and return data.content[0].text.
async function runViaApi(prompt, model) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !String(key).trim()) {
    throw new Error("runClaude(api): ANTHROPIC_API_KEY is not set");
  }
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (err) {
    throw new Error(`runClaude(api): network error: ${err && err.message ? err.message : err}`);
  }

  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      body = "(could not read error body)";
    }
    throw new Error(`runClaude(api): HTTP ${res.status} ${res.statusText}: ${truncateErr(body)}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`runClaude(api): failed to parse response JSON: ${err && err.message ? err.message : err}`);
  }

  const text = extractApiText(data);
  if (typeof text !== "string") {
    throw new Error(`runClaude(api): no text content in response: ${truncateErr(JSON.stringify(data))}`);
  }
  return text;
}

// Pull the assistant text out of the API response, concatenating any text blocks defensively.
function extractApiText(data) {
  if (!data || !Array.isArray(data.content)) return undefined;
  const texts = data.content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text);
  if (texts.length > 0) return texts.join("");
  // Fallback: first content block with any string text.
  const first = data.content.find((b) => b && typeof b.text === "string");
  return first ? first.text : undefined;
}

// Keep error blobs in messages short and single-line.
function truncateErr(s, n = 500) {
  const str = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return str.length <= n ? str : str.slice(0, n - 1) + "…";
}
