#!/usr/bin/env node
/**
 * Live Translate — Node.js reference client
 * ------------------------------------------
 * Connects to the same /live WebSocket the Web frontend uses.
 *
 * Audio capture is delegated to **ffmpeg**, which is invoked as a child
 * process and emits 16 kHz mono Int16 LE PCM on its stdout. This package
 * therefore has zero native dependencies — the only thing you need on the
 * host is ffmpeg in PATH.
 *
 * Audio source is selectable:
 *   --source=mic     (default; uses the host default microphone via ffmpeg)
 *   --source=file    (transcodes a file via ffmpeg; --file=path required)
 *   --source=stdin   (reads raw Int16 LE mono PCM at 16 kHz from stdin;
 *                     useful when you want to bypass ffmpeg entirely)
 *
 * Protocol (every WebSocket frame is one JSON message):
 *
 *   Client -> server:
 *     { audioBlob: "<base64>", mimeType: "audio/pcm;rate=16000" }
 *     { action: "flush" }
 *     { type: "pong" }
 *
 *   Server -> client:
 *     { type: "connection_established" }
 *     { type: "ping" }
 *     { type: "transcription", originalText, translatedText, finished }
 *     { type: "transcription_finished" }
 *     { type: "transcription_interrupted" }
 *     { type: "translation_audio", audio: "<base64>", mimeType }
 *     { type: "usage", inputTokens, outputTokens }
 *     { type: "upstream_goaway", timeLeft }    // server-side Gemini connection is about to be rotated
 *     { type: "upstream_reset" }              // upstream rotated; client should drop buffered PCM tail
 *     { type: "error", message }
 *
 * Run: node src/index.mjs [--source=mic|file|stdin] [--file=path]
 */

// ---------------------------------------------------------------------------
// Config (CLI args + env)
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import WebSocket from "ws";
import { loadEnv } from "./load-env.mjs";
import { resolveFfmpeg } from "./resolve-ffmpeg.mjs";
import { resolveMic, buildMicInputArgs } from "./mic-picker.mjs";

// Load .env from CWD. Real shell env still wins (loadEnv only sets vars
// that are not already defined in process.env).
const envInfo = loadEnv(".env");
if (envInfo.loaded) {
  console.log(`[env] loaded ${envInfo.varsApplied} var(s) from ${envInfo.path}`);
}

const args = parseArgs(process.argv.slice(2));
const SOURCE = (args.source || process.env.LIVE_TRANSLATE_SOURCE_MODE || "mic").toLowerCase();
const FILE = args.file || process.env.LIVE_TRANSLATE_FILE || "";

const HOST = process.env.LIVE_TRANSLATE_HOST || "your-server.example.com";
const PORT = Number(process.env.LIVE_TRANSLATE_PORT || 443);
const SECURE = (process.env.LIVE_TRANSLATE_SECURE || "true") !== "false";
const LANG_SOURCE = process.env.LIVE_TRANSLATE_SOURCE || "Auto";
const LANG_TARGET = process.env.LIVE_TRANSLATE_TARGET || "Chinese (Simplified)";
const SILENCE_MS = Number(process.env.LIVE_TRANSLATE_SILENCE_MS || 1000);
const TOKEN = process.env.LIVE_TRANSLATE_TOKEN || "";

const SAMPLE_RATE = 16000; // Hz — must match server expectation
const CHANNELS = 1;
const CHUNK_SAMPLES = 1600; // 100 ms @ 16 kHz
const CHUNK_BYTES = CHUNK_SAMPLES * 2; // Int16 LE -> 2 bytes/sample

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      out[k] = v === undefined ? true : v;
    }
  }
  return out;
}

function buildUrl() {
  const proto = SECURE ? "wss" : "ws";
  const params = new URLSearchParams({
    source: LANG_SOURCE,
    target: LANG_TARGET,
    silenceMs: String(SILENCE_MS),
  });
  if (TOKEN) params.set("token", TOKEN);
  return `${proto}://${HOST}:${PORT}/live?${params.toString()}`;
}

function arrayBufferToBase64(buffer, byteOffset, byteLength) {
  const bytes = new Uint8Array(buffer, byteOffset, byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return Buffer.from(binary, "binary").toString("base64");
}

function fmtTimestamp() {
  return new Date().toLocaleTimeString();
}

// ---------------------------------------------------------------------------
// Audio sources
//
// Each source implements:
//   - async start(onChunk: (pcm: Buffer) => void): Promise<void>
//   - async stop(): Promise<void>
//
// PCM emitted on onChunk is Int16 LE mono @ SAMPLE_RATE. The WS layer slices
// into 1600-sample chunks before sending.
// ---------------------------------------------------------------------------

/**
 * Source: live microphone via ffmpeg.
 *
 * Resolves the mic to use via mic-picker.mjs (which supports the
 * LIVE_TRANSLATE_MIC env override and interactive selection when multiple
 * devices are present). Then spawns ffmpeg with platform-correct input args.
 */
async function makeMicSource(ffmpegPath) {
  const platform = process.platform;
  const mic = await resolveMic(ffmpegPath, platform);
  const inputArgs = buildMicInputArgs(mic, platform);

  const args = [
    ...inputArgs,
    "-ac", String(CHANNELS),
    "-ar", String(SAMPLE_RATE),
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "-loglevel", "error",
    "pipe:1",
  ];

  return await spawnFfmpegSource(args, `mic (${mic.name})`, ffmpegPath);
}

/** Source: transcode an audio file to 16 kHz mono Int16 PCM via ffmpeg. */
async function makeFileSource(filePath, ffmpegPath) {
  if (!filePath) {
    throw new Error("--source=file requires --file=path/to/audio");
  }
  const args = [
    "-i", filePath,
    "-ac", String(CHANNELS),
    "-ar", String(SAMPLE_RATE),
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "-loglevel", "error",
    "pipe:1",
  ];
  return await spawnFfmpegSource(args, `file (${filePath})`, ffmpegPath);
}

/** Source: read raw Int16 LE mono PCM from stdin at 16 kHz. Bypasses ffmpeg. */
async function makeStdinSource() {
  console.log(`[audio] reading raw Int16 LE mono PCM from stdin (Ctrl+D / EOF to end)`);
  return {
    async start(onChunk) {
      process.stdin.on("data", (chunk) => onChunk(chunk));
      process.stdin.on("end", () => {
        console.log(`[audio] stdin closed`);
      });
      process.stdin.on("error", (err) => {
        console.error(`[audio] stdin error: ${err.message}`);
      });
      if (process.stdin.isTTY) {
        console.warn(`[audio] stdin is a TTY with no piped input — nothing will be sent.`);
        console.warn(`[audio] example: ffmpeg -i input.wav -f s16le -ar 16000 -ac 1 - | node src/index.mjs --source=stdin`);
      }
    },
    async stop() {
      try { process.stdin.pause(); } catch (_) {}
    },
  };
}

/** Helper: spawn ffmpeg with the given args and pipe stdout to onChunk. */
async function spawnFfmpegSource(args, label, ffmpegPath) {
  let proc;
  try {
    proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    throw new Error(
      `failed to spawn ffmpeg (${ffmpegPath}): ${err.message}. Is ffmpeg in PATH? ` +
        `Run 'node src/check-ffmpeg.mjs' to verify.`,
    );
  }

  proc.on("error", (err) => {
    console.error(`[ffmpeg] spawn error: ${err.message}`);
  });
  let stderrBuf = "";
  proc.stderr.on("data", (d) => (stderrBuf += d.toString()));
  proc.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[ffmpeg] exited code=${code} signal=${signal}`);
      if (stderrBuf.trim()) console.error(`[ffmpeg stderr]\n${stderrBuf.trim()}`);
    } else {
      console.log(`[ffmpeg] exited code=${code}`);
    }
  });

  console.log(`[audio] source: ${label}`);
  console.log(`[audio] cmd: ${ffmpegPath} ${args.join(" ")}`);

  return {
    async start(onChunk) {
      proc.stdout.on("data", (chunk) => onChunk(chunk));
    },
    async stop() {
      try { proc.kill("SIGTERM"); } catch (_) {}
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch (_) {}
      }, 1500);
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function pickSource(ffmpegPath) {
  if (SOURCE === "mic") return await makeMicSource(ffmpegPath);
  if (SOURCE === "file") return await makeFileSource(FILE, ffmpegPath);
  if (SOURCE === "stdin") return await makeStdinSource();
  throw new Error(`unknown --source=${SOURCE}; expected mic | file | stdin`);
}

async function main() {
  // Resolve ffmpeg up front (before opening the WS) so the user sees a
  // clear error if it's missing. The first source of truth is the env var
  // (which .env populates); if that path is missing or invalid we fall back
  // to system PATH / common install locations.
  let ffmpegPath = "ffmpeg"; // default; will be replaced by resolveFfmpeg()
  if (SOURCE !== "stdin") {
    try {
      const r = await resolveFfmpeg();
      ffmpegPath = r.ffmpeg;
      console.log(`[ffmpeg] using ${ffmpegPath}`);
      console.log(`[ffmpeg] source: ${r.source}`);
      console.log(`[ffmpeg] ${r.versionLine}`);
    } catch (err) {
      console.error(`[ffmpeg] ${err.message}`);
      process.exit(1);
    }
  }

  const url = buildUrl();

  // Long-lived state across reconnects.
  let sampleAcc = Buffer.alloc(0);
  let isClosing = false;
  let isReconnecting = false;
  let audio = null; // ffmpeg source — kept alive across WS reconnects for mic
  let ffmpegStarted = false;
  let ws = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  const MAX_RECONNECT_ATTEMPTS = 5;

  const cleanup = async () => {
    if (isClosing) return;
    isClosing = true;
    console.log(`\n[${fmtTimestamp()}] shutting down...`);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try { if (audio) await audio.stop(); } catch (_) {}
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: "flush" }));
      }
    } catch (_) {}
    try { if (ws) ws.close(); } catch (_) {}
    // Give the audio source a moment to actually exit (kill SIGTERM then
    // process.exit). 1500ms matches the SIGKILL escalation inside the
    // source's stop(). If audio.stop() took too long, force-exit.
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Build a fresh WS and attach the long-lived handlers. The handlers
  // reference the closed-over `ws` variable, so we deliberately create a new
  // socket and (when reusing the audio source) reset sampleAcc so the new
  // server session doesn't see stale PCM tail from the old one.
  const connect = () => {
    console.log(`[${fmtTimestamp()}] connecting to ${url}`);
    ws = new WebSocket(url);

    ws.on("open", async () => {
      console.log(`[${fmtTimestamp()}] [ws] connected`);
      reconnectAttempts = 0;
      isReconnecting = false;
      sampleAcc = Buffer.alloc(0);

      if (!ffmpegStarted) {
        try {
          audio = await pickSource(ffmpegPath);
        } catch (err) {
          // Print full message (it may include raw ffmpeg stderr as guidance).
          console.error(`[audio] ${err.message}`);
          cleanup();
          return;
        }

        audio.start((pcmChunk) => {
          sampleAcc = Buffer.concat([sampleAcc, pcmChunk]);
          while (sampleAcc.length >= CHUNK_BYTES && !isClosing) {
            const slice = sampleAcc.subarray(0, CHUNK_BYTES);
            sampleAcc = sampleAcc.subarray(CHUNK_BYTES);
            const b64 = arrayBufferToBase64(slice.buffer, slice.byteOffset, slice.byteLength);
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ audioBlob: b64, mimeType: "audio/pcm;rate=16000" }));
            }
          }
        }).catch((err) => {
          console.error(`[audio] source error: ${err.message}`);
          cleanup();
        });

        ffmpegStarted = true;
        if (SOURCE === "mic") {
          console.log(`[${fmtTimestamp()}] [audio] capturing microphone — speak into it. Ctrl+C to stop.`);
        }
      } else {
        console.log(`[${fmtTimestamp()}] [audio] reusing existing audio source`);
      }
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        console.error(`[ws] parse error: ${err.message}`);
        return;
      }

      switch (msg.type) {
        case "connection_established":
          console.log(`[${fmtTimestamp()}] [ws] server says hello`);
          break;
        case "transcription":
          if (msg.originalText || msg.translatedText) {
            console.log(`[${fmtTimestamp()}] [trans] 原: ${msg.originalText || ""}`);
            console.log(`[${fmtTimestamp()}] [trans] 译: ${msg.translatedText || ""}`);
          }
          break;
        case "transcription_finished":
          // console.log(`[${fmtTimestamp()}] [trans] segment finished`);
          break;
        case "transcription_interrupted":
          console.log(`[${fmtTimestamp()}] [trans] interrupted`);
          break;
        case "translation_audio":
          // We don't play audio in this console reference; PCM bytes are
          // available on msg.audio if you want to pipe them to speakers.
          break;
        case "usage":
          console.log(`[${fmtTimestamp()}] [usage] tokens 入=${msg.inputTokens} 出=${msg.outputTokens}`);
          break;
        case "upstream_goaway":
          // Server told us the Gemini Live upstream is about to be rotated.
          // This is informational — `upstream_reset` follows shortly.
          console.log(`[${fmtTimestamp()}] [upstream] GoAway timeLeft=${msg.timeLeft ?? "?"}`);
          break;
        case "upstream_reset":
          // The server rotated its Gemini Live upstream. Drop our buffered
          // PCM tail so the next chunk we send belongs to the new session.
          console.log(`[${fmtTimestamp()}] [upstream] reset; clearing buffered PCM tail`);
          sampleAcc = Buffer.alloc(0);
          break;
        case "error":
          // Server explicitly rejected us (auth, model unavailable, etc.).
          // Stop the audio source immediately and exit so the user sees the
          // error and isn't left with the mic still rolling.
          console.error(`[${fmtTimestamp()}] [error] ${msg.error || "(no message)"}`);
          cleanup();
          return;
        case "ping":
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "pong" }));
          }
          break;
        default:
          console.log(`[${fmtTimestamp()}] [ws] unknown msg: ${JSON.stringify(msg).slice(0, 200)}`);
      }
    });

    ws.on("error", (err) => {
      console.error(`[ws] error: ${err.message || err}`);
      // Don't cleanup() here — the close handler will decide whether to
      // cleanup (user-initiated) or reconnect (unexpected).
    });

    ws.on("close", (code, reason) => {
      const reasonStr = reason?.toString?.() || "";
      console.log(`[${fmtTimestamp()}] [ws] closed code=${code} reason=${reasonStr}`);

      if (isClosing) {
        cleanup();
        return;
      }

      // file/stdin sources can't meaningfully resume after a WS drop — the
      // file is already consumed / stdin already EOF'd. Refuse to reconnect.
      if (SOURCE !== "mic" && reconnectAttempts > 0) {
        console.error(`[ws] reconnect skipped: --source=${SOURCE} cannot resume after WS drop`);
        cleanup();
        return;
      }

      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error(`[ws] reconnect exhausted after ${MAX_RECONNECT_ATTEMPTS} attempts; exiting`);
        cleanup();
        return;
      }

      reconnectAttempts += 1;
      isReconnecting = true;
      const delay = Math.min(500 * Math.pow(2, reconnectAttempts - 1), 8000);
      console.warn(`[ws] scheduling reconnect #${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (isClosing) return;
        try {
          connect();
        } catch (err) {
          console.error(`[ws] reconnect failed: ${err.message}`);
          cleanup();
        }
      }, delay);
    });
  };

  connect();
}

main().catch((err) => {
  console.error(`[fatal] ${err.message || err}`);
  process.exit(1);
});