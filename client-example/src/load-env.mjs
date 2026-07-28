/**
 * Tiny .env loader (no external dependency).
 *
 * Reads KEY=VALUE pairs from a file (default: ./.env) and merges them into
 * process.env unless the variable is already set in the real environment
 * (real env wins, so production deploys still override).
 *
 * Supports:
 *   - lines like  KEY=value
 *   - blank lines
 *   - lines starting with # (comments)
 *   - quoted values:  KEY="some value with spaces"
 *   - unquoted values:  KEY=value-with-no-spaces
 *   - export KEY=value
 *
 * Does NOT support variable expansion (${OTHER}) — keep it simple.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function stripQuotes(v) {
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

export function loadEnv(filePath = ".env") {
  const abs = resolve(process.cwd(), filePath);
  if (!existsSync(abs)) return { loaded: false, path: abs };

  const text = readFileSync(abs, "utf8");
  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Drop optional `export ` prefix.
    const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;

    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;

    const key = stripped.slice(0, eq).trim();
    const value = stripQuotes(stripped.slice(eq + 1).trim());

    // Real env wins: don't overwrite a variable that was already set in the
    // shell. This lets users do `LIVE_TRANSLATE_TOKEN=xyz npm start` to
    // temporarily override .env values.
    if (process.env[key] === undefined) {
      process.env[key] = value;
      count++;
    }
  }
  return { loaded: true, path: abs, varsApplied: count };
}