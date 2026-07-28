#!/usr/bin/env node
/**
 * Verify that ffmpeg is installed and accessible.
 * Run: node src/check-ffmpeg.mjs
 *
 * Exits 0 if found, 1 if missing. Prints the path/version on success and
 * install instructions on failure.
 */

import { spawn } from "node:child_process";

function tryFfmpeg(cmd, args) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => resolve({ ok: false, error: err.message, stdout, stderr }));
    proc.on("exit", (code) => {
      if (code === 0) resolve({ ok: true, stdout, stderr, cmd });
      else resolve({ ok: false, exitCode: code, stdout, stderr, cmd });
    });
  });
}

async function main() {
  const candidates =
    process.platform === "win32"
      ? ["ffmpeg", "ffmpeg.exe", "C:\\ffmpeg\\bin\\ffmpeg.exe"]
      : ["ffmpeg", "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"];

  for (const cmd of candidates) {
    const r = await tryFfmpeg(cmd, ["-version"]);
    if (r.ok) {
      const firstLine = r.stdout.split("\n")[0].trim();
      console.log(`✓ ffmpeg found: ${cmd}`);
      console.log(`  ${firstLine}`);
      process.exit(0);
    }
  }

  console.error("✗ ffmpeg not found on PATH or in common locations.");
  console.error("");
  console.error("Install instructions:");
  if (process.platform === "win32") {
    console.error("  - winget install Gyan.FFmpeg");
    console.error("  - choco install ffmpeg");
    console.error("  - or download from https://www.gyan.dev/ffmpeg/builds/");
  } else if (process.platform === "darwin") {
    console.error("  - brew install ffmpeg");
  } else {
    console.error("  - sudo apt install ffmpeg       (Debian/Ubuntu)");
    console.error("  - sudo dnf install ffmpeg       (Fedora)");
    console.error("  - sudo pacman -S ffmpeg         (Arch)");
  }
  console.error("");
  console.error("After installing, verify with: ffmpeg -version");
  process.exit(1);
}

main().catch((err) => {
  console.error(`check failed: ${err.message}`);
  process.exit(1);
});