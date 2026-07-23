// 本地用户设置的持久化。
// 目前包含:
//   - silenceMs: 服务端 VAD 静默阈值(毫秒)。下次新建 Gemini Live 连接时生效。
//   - fontSize: 转写面板字号(像素)。实时生效。
//   - tokenUsage: 累计 token 计数(input / output)。跨会话保留,
//     刷新或关闭页面时不清零,直到用户主动清除或清掉 localStorage。
//
// 持久化键使用版本后缀,以后字段名变更时可方便做迁移。

export type Settings = {
  silenceMs: number;
  fontSize: number;
};

export type TokenUsage = {
  input: number;
  output: number;
};

const STORAGE_KEY = 'live-translate.settings.v1';
const TOKEN_STORAGE_KEY = 'live-translate.token-usage.v1';

// 默认值参考官方文档:
//   * silenceMs = 600 —— "balanced"档位,适合多数口语。
//   * fontSize = 25 —— 紧凑默认值,适合长段转写。
export const DEFAULT_SETTINGS: Settings = {
  silenceMs: 600,
  fontSize: 25,
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
    };
  } catch {
    // localStorage 不可用 / JSON 损坏 —— 回退默认。
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // 隐私模式 / 配额超限 —— 静默失败,设置仅本次会话生效。
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
    // 同 saveSettings。
  }
}

export function clearTokenUsage(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // 同上。
  }
}

// 给 slider 用的"VAD 档位"提示
export function vadLabel(ms: number): string {
  if (ms <= 250) return '灵敏(可能切碎句子)';
  if (ms <= 900) return '平衡(推荐)';
  return '迟钝(等待更久才断句)';
}