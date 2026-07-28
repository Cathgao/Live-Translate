#!/usr/bin/env node
/**
 * Diagnostic tool for the audio device scanner.
 *
 * On Windows, ffmpeg prints dshow device names using the *console's* code
 * page, which is usually GBK / CP936 on Chinese systems. This script:
 *
 *   1. Runs `ffmpeg -list_devices true -f dshow -i dummy`
 *   2. Captures the raw stderr bytes
 *   3. Decodes them with every candidate encoding (utf8, gbk, cp936,
 *      cp1252, latin1) and prints all of them so we can see which one
 *      yields legible Chinese device names.
 *   4. Runs our parser against each encoding and shows which devices it
 *      finds.
 *
 * Run: node src/diag-devices.mjs
 *
 * After running, paste the entire output back so we can fix the picker.
 */

import { spawn } from "node:child_process";
import { loadEnv } from "./load-env.mjs";
import { resolveFfmpeg } from "./resolve-ffmpeg.mjs";

const ENCODINGS = ["utf8", "gbk", "cp936", "cp1252", "latin1"];

async function runFfmpegProbe(ffmpegPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stderrChunks = [];
    const stdoutChunks = [];
    proc.stderr.on("data", (d) => stderrChunks.push(d));
    proc.stdout.on("data", (d) => stdoutChunks.push(d));
    proc.on("error", (err) => reject(err));
    proc.on("exit", () => {
      resolve({
        stderrBuf: Buffer.concat(stderrChunks),
        stdoutBuf: Buffer.concat(stdoutChunks),
      });
    });
  });
}

/** Naive parser: pull every line that looks like an audio input device. */
function parseAudioSection(text) {
  // Same shape as mic-picker.mjs's listDshowAudioMics regex.
  const audioLineRe = /^(?:\[[^\]]+\])?\s*"((?:[^"\\]|\\.)*)"\s*\(\s*audio(?:\s*,\s*[^)]*)?\s*\)\s*$/;
  const altNameRe = /^\s*Alternative name\s+"((?:[^"\\]|\\.)*)"\s*$/;
  const lines = text.split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(audioLineRe);
    if (!m) continue;
    let alt = null;
    const next = lines[i + 1];
    if (next) {
      const a = next.match(altNameRe);
      if (a) alt = a[1];
    }
    found.push({ name: m[1], alternative: alt });
  }
  return found;
}

async function main() {
  loadEnv(".env");
  let ffmpegPath;
  try {
    const r = await resolveFfmpeg();
    ffmpegPath = r.ffmpeg;
    console.log(`[diag] using ffmpeg: ${ffmpegPath}`);
  } catch (err) {
    console.error(`[diag] ${err.message}`);
    process.exit(1);
  }

  console.log(`[diag] running: ffmpeg -hide_banner -list_devices true -f dshow -i dummy`);
  const { stderrBuf, stdoutBuf } = await runFfmpegProbe(ffmpegPath);

  console.log(`[diag] captured ${stderrBuf.length} stderr bytes, ${stdoutBuf.length} stdout bytes`);
  console.log("");

  console.log("=== Raw stderr as hex (first 512 bytes) ===");
  const slice = stderrBuf.subarray(0, Math.min(512, stderrBuf.length));
  console.log(slice.toString("hex").match(/.{1,2}/g)?.join(" ").slice(0, 600) || "(empty)");
  console.log("");

  for (const enc of ENCODINGS) {
    let text;
    try {
      text = stderrBuf.toString(enc);
    } catch (err) {
      console.log(`=== Decoded as ${enc} ===`);
      console.log(`  failed: ${err.message}`);
      console.log("");
      continue;
    }
    console.log(`=== Decoded as ${enc} (length ${text.length}) ===`);
    // Print every line that looks like a dshow device line (quoted name
    // with or without '(audio)'). Helps eyeball which encoding is right.
    const lines = text.split(/\r?\n/);
    let any = false;
    for (const line of lines) {
      if (/^\s*(?:\[[^\]]+\]\s*)?"[^"]+"/.test(line)) {
        console.log(`  ${JSON.stringify(line)}`);
        any = true;
      }
    }
    if (!any) console.log("  (no quoted lines)");
    const parsed = parseAudioSection(text);
    console.log(`  parser found ${parsed.length} device(s) with this encoding:`);
    parsed.forEach((p, i) => console.log(`    [${i + 1}] name=${JSON.stringify(p.name)} alt=${JSON.stringify(p.alternative)}`));
    console.log("");
  }

  console.log("=== Done. Copy the output above and send it back. ===");
}

main().catch((err) => {
  console.error(`[fatal] ${err.message || err}`);
  process.exit(1);
});