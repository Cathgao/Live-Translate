// Thin wrapper around the Tauri commands in `src-tauri/src/config.rs`.
// Configuration is persisted to a JSON file in the OS app-data directory,
// NOT to localStorage and NOT to Vite env vars. This means:
//
//   - The compiled .exe never contains the user's WebSocket URL.
//   - The user can inspect/edit settings.json with any text editor.
//   - Settings survive WebView2 data clears because they're written to disk.

import { invoke } from "@tauri-apps/api/core";

export interface AppConfig {
  wsUrl: string;
}

/** Returns defaults if the file is missing or unparseable. */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const c = await invoke<AppConfig | null>("get_config");
    if (!c) return { wsUrl: "" };
    // Rust serialises `ws_url`; normalise to the camelCase we use on the JS side.
    const raw = (c as unknown as { ws_url?: string }).ws_url ?? c.wsUrl ?? "";
    return { wsUrl: raw };
  } catch (err) {
    console.warn("[config] loadConfig failed, using defaults:", err);
    return { wsUrl: "" };
  }
}

export async function saveConfig(cfg: AppConfig): Promise<void> {
  await invoke("save_config", {
    // Rust struct field is `ws_url`; serde will accept either thanks to
    // `#[serde(default)]` but we send the exact key to be explicit.
    config: { ws_url: cfg.wsUrl },
  });
}

/**
 * Validate a WebSocket URL string. Returns null if valid, otherwise a
 * human-readable error message suitable for display under the input box.
 *
 * Rules:
 *   - Must start with ws:// or wss://
 *   - Must have a host after the scheme
 *   - Must end with a slash + path (e.g. /live), not bare host
 */
export function validateWsUrl(s: string): string | null {
  const trimmed = s.trim();
  if (!trimmed) return "请填写 WebSocket 地址";
  if (!/^wss?:\/\//i.test(trimmed)) {
    return "必须以 ws:// 或 wss:// 开头";
  }
  // Strip scheme then sanity-check what's left.
  const rest = trimmed.replace(/^wss?:\/\//i, "");
  if (!rest) return "缺少主机名";
  // Require a path segment (at least "/x"). Bare "host" or "host:port" is rejected.
  if (!rest.includes("/")) {
    return "缺少路径，例如 /live";
  }
  // The host portion (before the first /) must be non-empty and not contain spaces.
  const hostPart = rest.split("/", 1)[0];
  if (!hostPart || /\s/.test(hostPart)) {
    return "主机名格式无效";
  }
  return null;
}