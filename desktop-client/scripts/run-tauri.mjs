#!/usr/bin/env node
// Wrapper to run `tauri dev` / `tauri build` with cargo on PATH.
// `tauri dev` spawns `cargo` as a subprocess; on Windows the bash PATH doesn't
// include C:\Users\<user>\.cargo\bin unless rustup just ran. We push it
// explicitly so the spawned cargo can be found.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const arg = process.argv[2];
if (!arg || (arg !== "dev" && arg !== "build")) {
  console.error("usage: node scripts/run-tauri.mjs <dev|build>");
  process.exit(1);
}

const cargoBin = join(homedir(), ".cargo", "bin");
if (!existsSync(cargoBin)) {
  console.error(`cargo bin not found at ${cargoBin}; is rustup installed?`);
  process.exit(1);
}

// Resolve @tauri-apps/cli entry directly so we can spawn node without .cmd shim.
const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, "..", "node_modules", "@tauri-apps", "cli", "tauri.js");
if (!existsSync(cliEntry)) {
  console.error(`tauri.js not found at ${cliEntry}; did you run 'npm install'?`);
  process.exit(1);
}

// Prepend cargoBin to PATH so `cargo metadata` resolves.
const sep = process.platform === "win32" ? ";" : ":";
const newPath = cargoBin + sep + (process.env.PATH || "");

const child = spawn(process.execPath, [cliEntry, arg], {
  stdio: "inherit",
  env: { ...process.env, PATH: newPath },
  shell: false,
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("[run-tauri] spawn error:", err);
  process.exit(1);
});