// Persistent settings — stored in localStorage. Mirrors the shape used by the
// web frontend with a few extra fields for the desktop client.

export const SOURCE_LANGUAGES = [
  "Auto",
  "English",
  "Chinese (Simplified)",
  "Spanish",
  "French",
  "Japanese",
  "Korean",
  "German",
];

export type FrameFormat = "prefix-multi" | "json-single";

export interface Settings {
  silenceMs: number;
  fontSize: number;
  sourceLang: string;
  targetLang: string;
  preventSleep: boolean;
  serial: {
    autoConnect: boolean;
    baud: number;
    dataBits: number; // 7 or 8
    stopBits: number; // 1 or 2
    parity: "none" | "even" | "odd";
    lineEnding: "\r\n" | "\n" | "none";
    frameFormat: FrameFormat;
    lastPortName: string;
  };
}

export interface TokenUsage {
  input: number;
  output: number;
}

const STORAGE_KEY = "live-translate-desktop.settings.v1";
const TOKEN_STORAGE_KEY = "live-translate-desktop.token-usage.v1";

export const DEFAULT_SETTINGS: Settings = {
  silenceMs: 1000,
  fontSize: 20,
  sourceLang: "Auto",
  targetLang: "Chinese (Simplified)",
  preventSleep: true,
  serial: {
    autoConnect: false,
    baud: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    lineEnding: "\r\n",
    frameFormat: "prefix-multi",
    lastPortName: "",
  },
};

export const DEFAULT_TOKEN_USAGE: TokenUsage = { input: 0, output: 0 };

export const RANGES = {
  silenceMs: { min: 100, max: 2000, step: 50 },
  fontSize: { min: 14, max: 48, step: 1 },
} as const;

export const BAUD_RATES = [
  9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
];

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    const lang = typeof parsed?.sourceLang === "string" &&
      SOURCE_LANGUAGES.includes(parsed.sourceLang)
      ? parsed.sourceLang
      : DEFAULT_SETTINGS.sourceLang;
    const target = typeof parsed?.targetLang === "string" &&
      SOURCE_LANGUAGES.includes(parsed.targetLang) &&
      parsed.targetLang !== "Auto"
      ? parsed.targetLang
      : DEFAULT_SETTINGS.targetLang;
    const serialIn = parsed?.serial ?? {};
    return {
      silenceMs: clamp(Number(parsed?.silenceMs), RANGES.silenceMs.min, RANGES.silenceMs.max),
      fontSize: clamp(Number(parsed?.fontSize), RANGES.fontSize.min, RANGES.fontSize.max),
      sourceLang: lang,
      targetLang: target,
      preventSleep: typeof parsed?.preventSleep === "boolean" ? parsed.preventSleep : DEFAULT_SETTINGS.preventSleep,
      serial: {
        autoConnect: typeof serialIn.autoConnect === "boolean" ? serialIn.autoConnect : DEFAULT_SETTINGS.serial.autoConnect,
        baud: BAUD_RATES.includes(Number(serialIn.baud)) ? Number(serialIn.baud) : DEFAULT_SETTINGS.serial.baud,
        dataBits: serialIn.dataBits === 7 ? 7 : 8,
        stopBits: serialIn.stopBits === 2 ? 2 : 1,
        parity: ["none", "even", "odd"].includes(serialIn.parity) ? serialIn.parity : "none",
        lineEnding: ["\r\n", "\n", "none"].includes(serialIn.lineEnding) ? serialIn.lineEnding : "\r\n",
        frameFormat: serialIn.frameFormat === "json-single" ? "json-single" : "prefix-multi",
        lastPortName: typeof serialIn.lastPortName === "string" ? serialIn.lastPortName : "",
      },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

export function loadTokenUsage(): TokenUsage {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TOKEN_USAGE };
    const parsed = JSON.parse(raw);
    return {
      input: clamp(Math.floor(Number(parsed?.input) || 0), 0, Number.MAX_SAFE_INTEGER),
      output: clamp(Math.floor(Number(parsed?.output) || 0), 0, Number.MAX_SAFE_INTEGER),
    };
  } catch {
    return { ...DEFAULT_TOKEN_USAGE };
  }
}

export function saveTokenUsage(u: TokenUsage): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(u));
  } catch {}
}

export function clearTokenUsage() {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {}
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  return `${(n / 1000).toFixed(1)}k`;
}