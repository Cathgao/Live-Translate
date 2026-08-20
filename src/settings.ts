
export type Settings = {
  silenceMs: number;
  fontSize: number;
  preventSleep: boolean;
};

export type TokenUsage = {
  input: number;
  output: number;
};

const STORAGE_KEY = 'live-translate.settings.v1';
const TOKEN_STORAGE_KEY = 'live-translate.token-usage.v1';
export const TARGET_LANGUAGES = [
  'Chinese (Simplified)',
  'Chinese (Traditional)',
  'English',
  'Japanese',
  'Korean',
  'Spanish',
  'French',
  'German',
  'Russian',
  'Portuguese',
  'Italian',
  'Arabic',
  'Hindi',
  'Vietnamese',
  'Thai',
  'Polish',
];
export const DEFAULT_SETTINGS: Settings = {
  silenceMs: 1000,
  fontSize: 25,
  preventSleep: true,
};

export const DEFAULT_TOKEN_USAGE: TokenUsage = {
  input: 0,
  output: 0,
};

// 滑块允许范围
export const RANGES = {
  silenceMs: { min: 100, max: 2000, step: 50 },
  fontSize: { min: 16, max: 72, step: 1 },
} as const;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      silenceMs: clamp(
        Number(parsed?.silenceMs),
        RANGES.silenceMs.min,
        RANGES.silenceMs.max,
      ),
      fontSize: clamp(
        Number(parsed?.fontSize),
        RANGES.fontSize.min,
        RANGES.fontSize.max,
      ),
      preventSleep: typeof parsed?.preventSleep === 'boolean' ? parsed.preventSleep : DEFAULT_SETTINGS.preventSleep,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
  }
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
  } catch {
  }
}

export function clearTokenUsage(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
  }
}

export function vadLabel(ms: number): string {
  if (ms <= 250) return '灵敏(可能切碎句子)';
  if (ms <= 900) return '平衡(推荐)';
  return '迟钝(等待更久才断句)';
}