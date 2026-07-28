/**
 * Microphone discovery + interactive picker.
 *
 * - listMics(ffmpegPath, platform): returns [{name, label, encoding}, ...]
 *   of audio input devices. The platform-specific calls each shell out to
 *   ffmpeg's own device enumeration.
 *
 *   Windows dshow device names are returned in the *console's* code page
 *   by ffmpeg (typically CP936/GBK on Chinese systems, CP1252 on Western).
 *   We grab stderr as raw bytes and try several candidate encodings; the
 *   one that yields the most successfully-parsed device lines wins.
 *
 * - resolveMic(ffmpegPath): high-level entrypoint. If LIVE_TRANSLATE_MIC
 *   is set, uses it directly (pure-numeric => 1-based index from the
 *   scanned list; anything else => literal device name). If not, scans
 *   devices and either picks automatically (1 device) or shows a numbered
 *   list and waits for the user to type a number. On a TTY-less stdin
 *   (e.g. piped input, CI), falls back to picking the first device.
 *
 * - buildMicInputArgs(mic, platform): build the ffmpeg -i <mic> pair.
 */

import { spawn } from "node:child_process";

/**
 * Try several candidate encodings on a raw buffer and return the decoding
 * that yields the largest number of well-formed "quoted device name" lines.
 * Returns { text, encoding } or null if no encoding produced a valid parse.
 *
 * Note: Node's Buffer.toString() only natively supports utf8 / latin1 /
 * ascii. CP936 / GBK / CP1252 would need iconv-lite, which we don't want
 * as a dep. In practice every recent ffmpeg Windows build emits UTF-8 on
 * stderr (per the user's hex dump), so utf8 + latin1 covers the bases.
 */
function bestDecode(rawBuf) {
  const candidates = ["utf8", "latin1"];

  let best = null;
  for (const enc of candidates) {
    let text;
    try {
      text = rawBuf.toString(enc);
    } catch (_) {
      continue;
    }
    const count = countQuotedDeviceLines(text);
    if (count > 0 && (best === null || count > best.count)) {
      best = { text, encoding: enc, count };
    }
  }
  return best;
}

/** How many lines look like a quoted dshow / avfoundation device name? */
function countQuotedDeviceLines(text) {
  let n = 0;
  for (const raw of text.split(/\r?\n/)) {
    // Match either:
    //   - dshow (with or without [in#N @ 0x...] prefix):
    //       '"Name" (audio)'  /  '"Name" (audio, foo)'  /  '"Name" (video)'
    //   - avfoundation bare quoted name:
    //       '"Name"'
    const t = raw.trim();
    if (/^(?:\[[^\]]+\]\s*)?"([^"]+)"\s*(?:\(\s*audio(?:\s*,[^)]*)?\s*\)|\([^)]+\))?\s*$/.test(t)) n++;
  }
  return n;
}

/** Probe ffmpeg's DirectShow (Windows) device list. Returns audio inputs. */
function listDshowAudioMics(ffmpegPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      "-hide_banner",
      "-list_devices", "true",
      "-f", "dshow",
      "-i", "dummy",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const stderrChunks = [];
    proc.stderr.on("data", (d) => stderrChunks.push(d));
    proc.on("error", (err) => reject(err));
    proc.on("exit", () => {
      const rawBuf = Buffer.concat(stderrChunks);
      const decoded = bestDecode(rawBuf);

      // Always keep the raw bytes around for diagnostics — callers may
      // surface them when the parse fails.
      const result = { rawStderr: rawBuf, parsed: [] };

      if (!decoded) {
        resolve(result);
        return;
      }

      // ffmpeg's dshow output (with -hide_banner, the default) prints each
      // device as its own line WITHOUT a section header like "DirectShow
      // audio devices". Every device line has the form:
      //
      //   [in#N @ 0xADDR] "Device Name" (audio)        <- audio input
      //   [in#N @ 0xADDR] "Device Name" (video)        <- video capture
      //   [in#N @ 0xADDR]   Alternative name "..."     <- a follow-up line
      //
      // We just match lines that look like a quoted name with `(audio)`
      // (optionally with extra comma-separated tokens inside the parens).
      const audioLineRe = /^(?:\[[^\]]+\])?\s*"((?:[^"\\]|\\.)*)"\s*\(\s*audio(?:\s*,\s*[^)]*)?\s*\)\s*$/;
      const altNameRe = /^\s*Alternative name\s+"((?:[^"\\]|\\.)*)"\s*$/;

      const lines = decoded.text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(audioLineRe);
        if (!m) continue;
        const name = m[1];
        // The "Alternative name" line, if present, is the next line.
        let alt = null;
        const next = lines[i + 1];
        if (next) {
          const altMatch = next.match(altNameRe);
          if (altMatch) alt = altMatch[1];
        }
        result.parsed.push({
          name,
          label: alt,
          encoding: decoded.encoding,
        });
      }
      resolve(result);
    });
  });
}

/** Probe ffmpeg's AVFoundation (macOS) audio input list. */
function listAvfoundationAudioMics(ffmpegPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      "-list_devices", "true",
      "-f", "avfoundation",
      "-i", "",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const stderrChunks = [];
    proc.stderr.on("data", (d) => stderrChunks.push(d));
    proc.on("error", (err) => reject(err));
    proc.on("exit", () => {
      const rawBuf = Buffer.concat(stderrChunks);
      const decoded = bestDecode(rawBuf);
      const result = { rawStderr: rawBuf, parsed: [] };
      if (!decoded) { resolve(result); return; }

      const lines = decoded.text.split(/\r?\n/);
      let inAudio = false;
      for (const raw of lines) {
        const line = raw.trimEnd();
        if (line.includes("AVFoundation audio devices")) { inAudio = true; continue; }
        if (line.includes("AVFoundation video devices")) { inAudio = false; continue; }
        if (!inAudio) continue;
        // avfoundation prints:  [N] Name  OR  [AVFoundation input device @ 0x...] [N] Name
        const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
        if (m) result.parsed.push({ index: Number(m[1]), name: m[2].replace(/^"|"$/g, ""), encoding: decoded.encoding });
      }
      resolve(result);
    });
  });
}

/**
 * @returns {Promise<{parsed: Array, rawStderr: Buffer}>}
 *   parsed: { name, label?, index?, encoding } objects
 *   rawStderr: the original stderr buffer (for diagnostics)
 */
export async function listMics(ffmpegPath, platform) {
  if (platform === "win32") return await listDshowAudioMics(ffmpegPath);
  if (platform === "darwin") return await listAvfoundationAudioMics(ffmpegPath);
  // Linux ALSA: device enumeration isn't standardized via ffmpeg; we rely
  // on the user setting LIVE_TRANSLATE_MIC or accepting "default".
  return { parsed: [{ name: "default", label: "ALSA default" }], rawStderr: Buffer.alloc(0) };
}

/** Print a numbered list of mics to stdout. */
export function printMicList(mics, platform) {
  console.log("");
  console.log("Available microphones:");
  if (platform === "darwin") {
    mics.forEach((m, i) => {
      console.log(`  [${i + 1}] ${m.name}  (avfoundation index ${m.index})`);
    });
  } else {
    mics.forEach((m, i) => {
      console.log(`  [${i + 1}] ${m.name}${m.label ? ` (${m.label})` : ""}`);
    });
  }
  console.log("");
}

/** Read one line from stdin. If stdin isn't a TTY (e.g. CI), resolve null. */
function readLineFromStdin(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(null);
      return;
    }
    process.stdout.write(prompt);
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        const line = buf.slice(0, idx).trim();
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(line);
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

/**
 * Resolve the mic to use for the current run.
 *
 * Resolution priority:
 *   1. LIVE_TRANSLATE_MIC env:
 *        - pure digits ("1") => treat as 1-based index from the device list
 *        - anything else    => treat as a literal device name
 *   2. Scan devices; if exactly one, use it.
 *   3. If multiple, print the numbered list and ask the user to pick.
 *   4. If stdin isn't interactive (CI / pipe), fall back to the first.
 *
 * On any parse failure, throws with the raw ffmpeg stderr attached so the
 * user can see exactly what ffmpeg printed and pick a device manually.
 */
export async function resolveMic(ffmpegPath, platform) {
  const envMic = (process.env.LIVE_TRANSLATE_MIC || "").trim();

  // Helper: turn a "listMics" result into the same shape as before, throwing
  // with rich diagnostics on failure.
  async function discover() {
    const { parsed, rawStderr } = await listMics(ffmpegPath, platform);
    if (parsed.length > 0) return { parsed, rawStderr };
    // Nothing parsed. Surface the raw bytes the user can inspect.
    const hint = rawStderr.length > 0
      ? "Raw ffmpeg output was:\n" + rawStderr.toString("utf8") + "\n"
      : "(no stderr output from ffmpeg)";
    throw new Error(
      "no audio input devices could be parsed from ffmpeg. " +
      "If ffmpeg listed devices but we couldn't read them, your console " +
      "code page may need a custom encoding. To work around this, run\n" +
      "  ffmpeg -list_devices true -f dshow -i dummy\n" +
      "manually, copy the exact device name, and put it in .env as\n" +
      "  LIVE_TRANSLATE_MIC=\"<pasted name>\"\n" +
      "\n" + hint,
    );
  }

  if (envMic) {
    if (/^\d+$/.test(envMic)) {
      const { parsed, rawStderr } = await listMics(ffmpegPath, platform);
      const i = Number(envMic) - 1;
      if (i < 0 || i >= parsed.length) {
        throw new Error(
          `LIVE_TRANSLATE_MIC=${envMic} is out of range (1..${parsed.length}). ` +
          `Run 'node src/index.mjs --source=mic' interactively to see the list.`,
        );
      }
      const picked = parsed[i];
      console.log(`[audio] using mic [${envMic}] ${picked.name} (from LIVE_TRANSLATE_MIC env)`);
      return { ...picked, source: `env index ${envMic}` };
    }
    console.log(`[audio] using mic "${envMic}" (from LIVE_TRANSLATE_MIC env)`);
    return { name: envMic, source: "LIVE_TRANSLATE_MIC env" };
  }

  const { parsed: mics } = await discover();

  if (mics.length === 1) {
    console.log(`[audio] only one mic found: "${mics[0].name}" — using it`);
    return { ...mics[0], source: "auto (only device)" };
  }

  printMicList(mics, platform);
  const choice = await readLineFromStdin(`Pick a microphone [1-${mics.length}]: `);

  if (choice === null) {
    console.warn(`[audio] stdin is not interactive — auto-picking the first device.`);
    console.warn(`[audio] set LIVE_TRANSLATE_MIC=<name> in .env to lock the choice.`);
    return { ...mics[0], source: "auto (no tty)" };
  }

  const n = Number(choice);
  if (!Number.isInteger(n) || n < 1 || n > mics.length) {
    throw new Error(`invalid choice "${choice}" — expected a number 1..${mics.length}`);
  }
  const picked = mics[n - 1];
  console.log(`[audio] selected mic [${n}] ${picked.name}`);
  return { ...picked, source: `interactive (picked ${n})` };
}

/** Build the ffmpeg -i <mic> arg pair for the platform. */
export function buildMicInputArgs(mic, platform) {
  if (platform === "win32") {
    return ["-f", "dshow", "-i", `audio=${mic.name}`];
  }
  if (platform === "darwin") {
    if (mic.index != null) return ["-f", "avfoundation", "-i", `:${mic.index}`];
    return ["-f", "avfoundation", "-i", `:${mic.name}`];
  }
  return ["-f", "alsa", "-i", mic.name];
}