/**
 * Resolve the ffmpeg executable path.
 *
 * Priority:
 *   1. LIVE_TRANSLATE_FFMPEG env var (explicit override from .env or shell).
 *   2. System PATH lookup (which / where ffmpeg).
 *   3. Platform-specific common install locations.
 *
 * Each candidate is checked for executability via `spawn(cmd, ["-version"])`.
 * The first one that exits 0 wins. If none work, throws with install hints.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

function isExecutable(p) {
  // We don't have access to fs.access(X_OK) portably in a sync way without
  // node:fs/promises; instead we just test spawn() with a probe command.
  // Returning true here is OK because the actual probe below will reject
  // broken paths.
  return Boolean(p) && existsSync(p);
}

function tryProbe(cmd) {
  return new Promise((resolveProbe) => {
    let proc;
    try {
      proc = spawn(cmd, ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolveProbe({ ok: false, error: err.message, cmd });
      return;
    }
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.on("error", (err) => resolveProbe({ ok: false, error: err.message, cmd }));
    proc.on("exit", (code) => {
      if (code === 0) {
        resolveProbe({ ok: true, cmd, versionLine: stdout.split("\n")[0].trim() });
      } else {
        resolveProbe({ ok: false, exitCode: code, cmd });
      }
    });
  });
}

function platformCandidates() {
  if (process.platform === "win32") {
    return [
      "ffmpeg.exe",
      "ffmpeg",
      "C:\\ffmpeg\\bin\\ffmpeg.exe",
      "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
      "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
    ];
  }
  if (process.platform === "darwin") {
    return [
      "ffmpeg",
      "/opt/homebrew/bin/ffmpeg",
      "/usr/local/bin/ffmpeg",
      "/opt/local/bin/ffmpeg",
    ];
  }
  // linux / others
  return [
    "ffmpeg",
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/snap/bin/ffmpeg",
  ];
}

function installHints() {
  if (process.platform === "win32") {
    return [
      "Install ffmpeg on Windows:",
      "  winget install Gyan.FFmpeg",
      "  choco install ffmpeg",
      "  or download from https://www.gyan.dev/ffmpeg/builds/",
      "After installing, verify with: ffmpeg -version",
    ];
  }
  if (process.platform === "darwin") {
    return ["Install ffmpeg on macOS: brew install ffmpeg"];
  }
  return [
    "Install ffmpeg on Linux:",
    "  Debian/Ubuntu:  sudo apt install ffmpeg",
    "  Fedora:         sudo dnf install ffmpeg",
    "  Arch:           sudo pacman -S ffmpeg",
  ];
}

/**
 * @returns {Promise<{ffmpeg: string, source: string, versionLine: string}>}
 */
export async function resolveFfmpeg() {
  const candidates = [];
  const fromEnv = process.env.LIVE_TRANSLATE_FFMPEG;
  if (fromEnv && fromEnv.trim()) {
    candidates.push({ cmd: fromEnv.trim(), source: "LIVE_TRANSLATE_FFMPEG env / .env" });
  }
  for (const c of platformCandidates()) {
    candidates.push({ cmd: c, source: "system PATH / common location" });
  }

  for (const c of candidates) {
    // For absolute paths, do an existsSync pre-check so we can give a clearer
    // error if the user typed a wrong path in .env.
    const looksAbsolute = /[\\/]/.test(c.cmd);
    if (looksAbsolute && !isExecutable(c.cmd)) {
      // Skip silently — try next candidate.
      continue;
    }
    const r = await tryProbe(c.cmd);
    if (r.ok) {
      return { ffmpeg: r.cmd, source: c.source, versionLine: r.versionLine };
    }
  }

  // Nothing worked.
  const msg = [
    "ffmpeg not found on this system.",
    ...installHints(),
    "",
    "If you have ffmpeg installed at a custom path, set LIVE_TRANSLATE_FFMPEG",
    "in client-example/.env (or in your shell env).",
    "",
    "You can verify quickly with: node src/check-ffmpeg.mjs",
  ].join("\n");
  throw new Error(msg);
}