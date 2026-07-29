import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  Mic,
  Square,
  Loader2,
  AlertCircle,
  Settings as SettingsIcon,
  X,
  Minus,
  Maximize2,
  Minimize2,
  RefreshCw,
  Volume2,
  VolumeX,
  Send,
  Plug,
  Unplug,
  Trash2,
  Check,
  Pencil,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  AudioRecorderManager,
  TranslationAudioPlayer,
} from "./audio";
import { LiveClient } from "./ws";
import {
  serialList,
  serialOpen,
  serialClose,
  serialWrite,
  onSerialRxLine,
  onSerialRxError,
  onSerialClosed,
  type PortInfo,
  type RxLinePayload,
} from "./serial";
import {
  loadSettings,
  saveSettings,
  loadTokenUsage,
  saveTokenUsage,
  clearTokenUsage,
  formatTokens,
  SOURCE_LANGUAGES,
  BAUD_RATES,
  RANGES,
  DEFAULT_SETTINGS,
  type Settings,
  type FrameFormat,
} from "./settings";
import {
  loadConfig,
  saveConfig,
  validateWsUrl,
} from "./configStore";

// ---------------------------------------------------------------------------
// Frame format helpers — bridges WS transcription messages to UART TX.
// ---------------------------------------------------------------------------

function lineEndingBytes(s: Settings): number[] {
  const le = s.serial.lineEnding;
  if (le === "\r\n") return [0x0d, 0x0a];
  if (le === "\n") return [0x0a];
  return [];
}

function utf8Bytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

function buildTxLines(
  fmt: FrameFormat,
  orig: string,
  trans: string,
): string[] {
  if (fmt === "json-single") {
    const o = orig.replace(/[\r\n]+/g, " ");
    const t = trans.replace(/[\r\n]+/g, " ");
    if (!o && !t) return [];
    return [JSON.stringify({ o, t })];
  }
  // prefix-multi
  const lines: string[] = [];
  if (orig) lines.push(`ORIG:${orig.replace(/[\r\n]+/g, " ")}`);
  if (trans) lines.push(`TRANS:${trans.replace(/[\r\n]+/g, " ")}`);
  return lines;
}

async function txLines(portId: number, settings: Settings, lines: string[]) {
  if (lines.length === 0) return;
  const le = lineEndingBytes(settings);
  for (const line of lines) {
    const bytes = [...utf8Bytes(line), ...le];
    try {
      await serialWrite(portId, bytes);
    } catch (err) {
      console.warn("[serial-tx] write failed:", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Main app
// ---------------------------------------------------------------------------

const SEGMENT_COMMIT_MS = 5000; // matches web frontend default

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  // Flag: settings loaded from the OS config file on app startup. We don't
  // auto-open the modal on every launch — only when the URL is missing.
  const [configReady, setConfigReady] = useState(false);
  const updateSettings = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  };
  const updateSerialSettings = (patch: Partial<Settings["serial"]>) => {
    setSettings((prev) => {
      const next = { ...prev, serial: { ...prev.serial, ...patch } };
      saveSettings(next);
      return next;
    });
  };

  const [isRecording, setIsRecording] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState("");

  // Two transcript buffers (committed base + live pending).
  const [originalBase, setOriginalBase] = useState("");
  const [translatedBase, setTranslatedBase] = useState("");
  const [originalLive, setOriginalLive] = useState("");
  const [translatedLive, setTranslatedLive] = useState("");

  const [tokenUsage, setTokenUsageState] = useState(() => loadTokenUsage());
  const setTokenUsage = (u: { input: number; output: number }) => {
    setTokenUsageState(u);
    saveTokenUsage(u);
  };

  // Volume bars
  const volumeBarsRef = useRef<(HTMLDivElement | null)[]>([]);
  const [volume, setVolume] = useState(0);

  // Tabs / dialogs
  const [showSettings, setShowSettings] = useState(false);
  const [showSerialPanel, setShowSerialPanel] = useState(false);

  // Audio auto-play toggle
  const [autoPlayAudio, setAutoPlayAudio] = useState(false);

  // Serial state
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [serialPortId, setSerialPortId] = useState<number | null>(null);
  const [serialError, setSerialError] = useState("");
  const [rxLog, setRxLog] = useState<{ ts: number; line: string }[]>([]);
  const rxLogRef = useRef(rxLog);
  rxLogRef.current = rxLog;

  // Refs that survive across renders
  const wsRef = useRef<LiveClient | null>(null);
  const recorderRef = useRef<AudioRecorderManager | null>(null);
  const playerRef = useRef<TranslationAudioPlayer | null>(null);

  const pendingOrigRef = useRef("");
  const pendingTransRef = useRef("");
  const segmentCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -------------------------------------------------------------------------
  // Serial side: list / open / close + RX event handlers + command dispatch.
  // -------------------------------------------------------------------------

  const refreshPorts = useCallback(async () => {
    try {
      const list = await serialList();
      setPorts(list);
    } catch (err) {
      console.warn("[serial] list failed:", err);
      setSerialError(`列举串口失败: ${err}`);
    }
  }, []);

  const handleSerialConnect = useCallback(async () => {
    setSerialError("");
    if (!settings.serial.lastPortName) {
      setSerialError("请先选择串口");
      return;
    }
    try {
      const id = await serialOpen({
        port_name: settings.serial.lastPortName,
        baud: settings.serial.baud,
        data_bits: settings.serial.dataBits,
        stop_bits: settings.serial.stopBits,
        parity: settings.serial.parity,
      });
      setSerialPortId(id);
      console.log(`[serial] opened ${settings.serial.lastPortName} as id=${id}`);
    } catch (err) {
      setSerialError(`打开失败: ${err}`);
    }
  }, [settings.serial]);

  const handleSerialDisconnect = useCallback(async () => {
    if (serialPortId == null) return;
    try {
      await serialClose(serialPortId);
    } catch (err) {
      console.warn("[serial] close error:", err);
    }
    setSerialPortId(null);
  }, [serialPortId]);

  // Toggle mic (used by serial RX command — pre-registered, no-op for now).
  const toggleMicRef = useRef<() => void>(() => undefined);
  toggleMicRef.current = () => {
    console.log("[serial-cmd] TOGGLE_RECORD received (reserved for future)");
  };

  // RX event listeners.
  useEffect(() => {
    let unListenLine: (() => void) | null = null;
    let unListenErr: (() => void) | null = null;
    let unListenClosed: (() => void) | null = null;

    (async () => {
      unListenLine = await onSerialRxLine((p: RxLinePayload) => {
        const ts = p.ts_ms;
        setRxLog((prev) => {
          const next = [...prev, { ts, line: p.line }];
          return next.length > 200 ? next.slice(-200) : next;
        });
        // Reserved command parsing.
        const trimmed = p.line.trim();
        if (trimmed === "TOGGLE_RECORD") {
          toggleMicRef.current();
        } else if (trimmed === "PING") {
          if (serialPortId != null) {
            serialWrite(serialPortId, utf8Bytes("PONG")).catch(() => undefined);
          }
        }
      });
      unListenErr = await onSerialRxError((p) => {
        setSerialError(`串口读取错误 (id=${p.port_id}): ${p.error}`);
      });
      unListenClosed = await (async () => {
        const fn = await onSerialClosed((p) => {
          console.log(`[serial] closed id=${p.port_id} reason=${p.reason}`);
          setSerialPortId((curr) => (curr === p.port_id ? null : curr));
        });
        return fn;
      })();
    })().catch((err) => console.warn("[serial] listen setup failed:", err));

    return () => {
      unListenLine?.();
      unListenErr?.();
      unListenClosed?.();
    };
  }, [serialPortId]);

  // Refresh port list on mount + whenever the serial panel opens.
  useEffect(() => {
    refreshPorts();
  }, [refreshPorts]);
  useEffect(() => {
    if (showSerialPanel) refreshPorts();
  }, [showSerialPanel, refreshPorts]);

  // -------------------------------------------------------------------------
  // App-level config (WebSocket URL) — loaded once on startup from the OS
  // config file. If empty, auto-open the settings dialog so the user can
  // paste their server URL. We never overwrite the URL from a stale local
  // copy; the file is the source of truth.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await loadConfig();
        if (cancelled) return;
        if (cfg.wsUrl) {
          setSettings((prev) => {
            // Only write to localStorage once we've hydrated.
            const next = { ...prev, wsUrl: cfg.wsUrl };
            saveSettings(next);
            return next;
          });
        } else {
          // First launch (or a wiped config file). Open the modal so the
          // user can't get stuck unable to record.
          setShowSettings(true);
        }
      } catch (err) {
        console.warn("[config] startup load failed:", err);
      } finally {
        if (!cancelled) setConfigReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const isWsConfigured = settings.wsUrl.trim().length > 0;

  // -------------------------------------------------------------------------
  // WS / mic lifecycle.
  // -------------------------------------------------------------------------

  const flushPending = useCallback((reason: string) => {
    console.log(`[commit] flush reason=${reason}`);
    const finalOrig = pendingOrigRef.current.trim();
    const finalTrans = pendingTransRef.current.trim();
    if (finalOrig) {
      setOriginalBase((prev) => (prev ? prev + "\n\n" : "") + finalOrig);
    }
    if (finalTrans) {
      setTranslatedBase((prev) => (prev ? prev + "\n\n" : "") + finalTrans);
    }
    pendingOrigRef.current = "";
    pendingTransRef.current = "";
    setOriginalLive("");
    setTranslatedLive("");
    if (segmentCommitTimer.current) {
      clearTimeout(segmentCommitTimer.current);
      segmentCommitTimer.current = null;
    }
  }, []);

  const armSilenceCommit = useCallback(() => {
    if (segmentCommitTimer.current) clearTimeout(segmentCommitTimer.current);
    segmentCommitTimer.current = setTimeout(() => {
      console.log("[commit] timer fired");
      segmentCommitTimer.current = null;
      flushPending("timer");
    }, SEGMENT_COMMIT_MS);
  }, [flushPending]);

  const stopRecording = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (recorderRef.current) {
      recorderRef.current.stop();
      recorderRef.current = null;
    }
    if (playerRef.current) {
      playerRef.current.stop();
      playerRef.current = null;
    }
    if (segmentCommitTimer.current) {
      clearTimeout(segmentCommitTimer.current);
      segmentCommitTimer.current = null;
    }
    setIsRecording(false);
    setIsConnecting(false);
  }, []);

  const startRecording = useCallback(async () => {
    setError("");
    if (!settings.wsUrl.trim()) {
      setError("请先在设置里填写 WebSocket 地址。");
      setShowSettings(true);
      return;
    }
    setOriginalLive("");
    setTranslatedLive("");
    pendingOrigRef.current = "";
    pendingTransRef.current = "";
    if (segmentCommitTimer.current) {
      clearTimeout(segmentCommitTimer.current);
      segmentCommitTimer.current = null;
    }

    const live = new LiveClient(
      {
        wsUrl: settings.wsUrl,
        source: settings.sourceLang,
        target: settings.targetLang,
        silenceMs: settings.silenceMs,
      },
      {
        onOpen: () => {
          // handled below via callbacks wired into the client
        },
        onConnectionEstablished: () => {
          console.log("[ws] hello from server");
        },
        onTranscription: async ({ originalText, translatedText }) => {
          const origDelta = originalText || "";
          const transDelta = translatedText || "";
          if (origDelta) {
            pendingOrigRef.current = pendingOrigRef.current
              ? pendingOrigRef.current + origDelta
              : origDelta;
          }
          if (transDelta) {
            pendingTransRef.current = pendingTransRef.current
              ? pendingTransRef.current + transDelta
              : transDelta;
          }
          setOriginalLive(pendingOrigRef.current);
          setTranslatedLive(pendingTransRef.current);
          armSilenceCommit();
          // Bridge to UART if open.
          if (serialPortId != null) {
            const lines = buildTxLines(
              settings.serial.frameFormat,
              origDelta,
              transDelta,
            );
            await txLines(serialPortId, settings, lines);
          }
        },
        onTranscriptionFinished: async () => {
          // Commit pending text + emit empty newline to UART.
          if (serialPortId != null) {
            const le = lineEndingBytes(settings);
            if (le.length > 0) {
              try {
                await serialWrite(serialPortId, le);
              } catch (_) {}
            }
          }
          flushPending("finished");
        },
        onTranscriptionInterrupted: () => {
          pendingOrigRef.current = "";
          pendingTransRef.current = "";
          setOriginalLive("");
          setTranslatedLive("");
          if (segmentCommitTimer.current) {
            clearTimeout(segmentCommitTimer.current);
            segmentCommitTimer.current = null;
          }
        },
        onTranslationAudio: (audio, mimeType) => {
          playerRef.current?.enqueue(audio);
        },
        onUsage: (input, output) => {
          setTokenUsage({ input, output });
        },
        onError: (msg) => {
          setError(msg);
          stopRecording();
        },
        onPing: () => undefined,
        onClose: () => {
          if (!wsRef.current?.manuallyClosed) {
            // Treat as connection loss without auto-reconnect.
            setIsRecording(false);
          }
        },
      },
    );
    wsRef.current = live;

    setIsConnecting(true);

    // Audio player.
    const player = new TranslationAudioPlayer();
    player.setMuted(!autoPlayAudio);
    playerRef.current = player;

    // Connect WS, then start recorder.
    live.connect();
    try {
      const recorder = new AudioRecorderManager();
      recorderRef.current = recorder;
      await recorder.start(
        (base64, mime) => live.sendAudioChunk(base64, mime),
        (vol) => {
          setVolume(vol);
          volumeBarsRef.current.forEach((bar, idx) => {
            if (bar) {
              const multiplier = 1 + (idx % 3) * 0.4;
              bar.style.height = `${Math.max(4, vol * 60 * multiplier)}px`;
            }
          });
        },
      );
    } catch (err: any) {
      const errName = err?.name || "Error";
      const errMsg = err?.message || String(err);
      console.warn("[mic] access issue:", errName, errMsg);
      setIsConnecting(false);
      if (errName === "NotAllowedError" || errName === "PermissionDeniedError") {
        setError(`麦克风已被系统隐私策略拒绝 (${errName})。`);
      } else if (errName === "NotFoundError") {
        setError(`未找到麦克风设备。`);
      } else {
        setError(`麦克风启动失败 (${errName}: ${errMsg})。`);
      }
      stopRecording();
      return;
    }

    setIsConnecting(false);
    setIsRecording(true);
  }, [
    settings,
    serialPortId,
    autoPlayAudio,
    armSilenceCommit,
    flushPending,
    stopRecording,
  ]);

  const toggleRecording = useCallback(() => {
    if (isRecording || isConnecting) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, isConnecting, startRecording, stopRecording]);

  // Update auto-play toggle on the existing player.
  useEffect(() => {
    playerRef.current?.setMuted(!autoPlayAudio);
  }, [autoPlayAudio]);

  // -------------------------------------------------------------------------
  // Window controls + drag region.
  // -------------------------------------------------------------------------

  const [isMaximized, setIsMaximized] = useState(false);

  // Track maximize state for the button icon.
  useEffect(() => {
    let unListen: (() => void) | null = null;
    (async () => {
      try {
        const win = getCurrentWindow();
        const cur = await win.isMaximized();
        setIsMaximized(cur);
        unListen = await win.onResized(async () => {
          try {
            setIsMaximized(await win.isMaximized());
          } catch (_) {}
        });
      } catch (err) {
        console.warn("[window] track maximize failed:", err);
      }
    })();
    return () => {
      try { unListen?.(); } catch (_) {}
    };
  }, []);

  const handleClose = useCallback(async () => {
    stopRecording();
    if (serialPortId != null) {
      try {
        await serialClose(serialPortId);
      } catch (_) {}
    }
    try {
      await getCurrentWindow().close();
    } catch (err) {
      console.warn("[window] close failed:", err);
    }
  }, [serialPortId, stopRecording]);

  const handleMinimize = useCallback(async () => {
    try {
      await getCurrentWindow().minimize();
    } catch (err) {
      console.warn("[window] minimize failed:", err);
    }
  }, []);

  const handleToggleMaximize = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      if (await win.isMaximized()) {
        await win.unmaximize();
      } else {
        await win.maximize();
      }
    } catch (err) {
      console.warn("[window] maximize toggle failed:", err);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div
      className="w-full h-full bg-slate-950 flex flex-col font-sans text-slate-100 overflow-hidden"
    >
      {/* Top bar: drag region + language + serial indicator + settings + close */}
      <div
        className="drag-region h-9 flex items-center justify-between px-3 bg-slate-900/80 border-b border-slate-800 shrink-0"
      >
        <div className="flex items-center gap-2 min-w-0">
          <select
            value={settings.targetLang}
            onChange={(e) => updateSettings({ targetLang: e.target.value })}
            disabled={isRecording || isConnecting}
            className="no-drag bg-slate-800 text-slate-100 text-xs px-2 py-1 rounded border border-slate-700 focus:outline-none cursor-pointer disabled:opacity-50"
            title="目标语言"
          >
            {SOURCE_LANGUAGES.filter((l) => l !== "Auto").map((lang) => (
              <option key={lang} value={lang} className="bg-slate-800 text-slate-100">
                {lang}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setShowSerialPanel((v) => !v)}
            className={`no-drag flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono border transition-colors ${
              serialPortId != null
                ? "bg-emerald-950/60 border-emerald-800 text-emerald-300"
                : "bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700"
            }`}
            title="串口"
          >
            {serialPortId != null ? <Plug className="w-3 h-3" /> : <Unplug className="w-3 h-3" />}
            <span>
              {serialPortId != null
                ? `${settings.serial.lastPortName} ${settings.serial.baud}`
                : "串口未连接"}
            </span>
          </button>
        </div>

        <div className="flex items-center gap-1">
          {!isWsConfigured && (
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="no-drag flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-mono bg-amber-950/60 border border-amber-700/70 text-amber-300 hover:bg-amber-900/70 transition-colors"
              title="WebSocket 地址未配置，点击填写"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              <span>未配置</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="no-drag w-7 h-7 rounded-full flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors"
            title="设置"
          >
            <SettingsIcon className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleMinimize}
            className="no-drag w-7 h-7 rounded-full flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors"
            title="最小化"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleToggleMaximize}
            className="no-drag w-7 h-7 rounded-full flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors"
            title={isMaximized ? "取消最大化" : "最大化"}
          >
            {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="no-drag w-7 h-7 rounded-full flex items-center justify-center bg-slate-800 hover:bg-red-700 text-slate-300 hover:text-white border border-slate-700 transition-colors"
            title="关闭"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-red-900/95 text-white px-4 py-2.5 text-xs font-medium flex items-center gap-2 border-b border-red-500/80">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
          <span className="flex-1 break-words font-mono opacity-95">{error}</span>
          <button
            onClick={() => setError("")}
            className="bg-red-800 hover:bg-red-700 text-red-100 font-bold px-2 py-0.5 rounded text-[10px]"
          >
            关闭
          </button>
        </div>
      )}

      {/* Serial inline panel (collapsible) */}
      {showSerialPanel && (
        <div className="bg-slate-900 border-b border-slate-800 p-3 space-y-2 shrink-0">
          <div className="flex items-center gap-2">
            <select
              value={settings.serial.lastPortName}
              onChange={(e) => updateSerialSettings({ lastPortName: e.target.value })}
              className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-blue-500"
            >
              <option value="">选择串口…</option>
              {ports.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} — {p.label} ({p.kind})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={refreshPorts}
              className="p-1.5 text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded"
              title="刷新串口列表"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-4 gap-2">
            <SerialSelect
              label="波特率"
              value={String(settings.serial.baud)}
              options={BAUD_RATES.map(String)}
              onChange={(v) => updateSerialSettings({ baud: Number(v) })}
            />
            <SerialSelect
              label="数据位"
              value={String(settings.serial.dataBits)}
              options={["7", "8"]}
              onChange={(v) => updateSerialSettings({ dataBits: Number(v) as 7 | 8 })}
            />
            <SerialSelect
              label="校验"
              value={settings.serial.parity}
              options={["none", "even", "odd"]}
              onChange={(v) => updateSerialSettings({ parity: v as any })}
            />
            <SerialSelect
              label="停止位"
              value={String(settings.serial.stopBits)}
              options={["1", "2"]}
              onChange={(v) => updateSerialSettings({ stopBits: Number(v) as 1 | 2 })}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <SerialSelect
              label="换行"
              value={settings.serial.lineEnding}
              options={["\r\n", "\n", "none"]}
              renderLabel={(v) => (v === "none" ? "无" : v.replace("\r", "\\r").replace("\n", "\\n"))}
              onChange={(v) => updateSerialSettings({ lineEnding: v as any })}
            />
            <SerialSelect
              label="发送格式"
              value={settings.serial.frameFormat}
              options={["prefix-multi", "json-single"]}
              renderLabel={(v) => (v === "prefix-multi" ? "ORIG:/TRANS: 多行" : "JSON 单行")}
              onChange={(v) => updateSerialSettings({ frameFormat: v as FrameFormat })}
            />
          </div>

          <div className="flex items-center gap-2">
            {serialPortId == null ? (
              <button
                type="button"
                onClick={handleSerialConnect}
                className="flex-1 flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white border border-emerald-800"
              >
                <Plug className="w-3.5 h-3.5" />
                <span>打开串口</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSerialDisconnect}
                className="flex-1 flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 border border-slate-600"
              >
                <Unplug className="w-3.5 h-3.5" />
                <span>关闭串口</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (serialPortId != null) {
                  const le = lineEndingBytes(settings);
                  const bytes = [...utf8Bytes("PING"), ...le];
                  serialWrite(serialPortId, bytes).catch(() => undefined);
                }
              }}
              disabled={serialPortId == null}
              className="px-3 py-1.5 rounded text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-50 flex items-center gap-1"
              title="发送 PING"
            >
              <Send className="w-3.5 h-3.5" />
              <span>PING</span>
            </button>
          </div>

          {serialError && (
            <div className="text-[11px] text-red-300 font-mono">{serialError}</div>
          )}

          {rxLog.length > 0 && (
            <details className="text-[11px]">
              <summary className="cursor-pointer text-slate-400 hover:text-slate-200 font-mono">
                RX 日志 ({rxLog.length})
              </summary>
              <div className="mt-1 max-h-32 overflow-y-auto bg-slate-950 border border-slate-800 rounded p-1.5 font-mono text-emerald-300 scrollbar-thin transcript">
                {rxLog.slice(-100).map((e, i) => (
                  <div key={i} className="break-all whitespace-pre-wrap">
                    {e.line}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* Main: two transcript panes */}
      <main className="flex-1 flex flex-col h-0 min-h-0">
        {/* Original */}
        <section className="flex-1 bg-slate-900/90 px-4 py-3 relative border-b border-slate-800/80 flex flex-col min-h-0">
          <div className="flex items-center gap-2 mb-2 shrink-0">
            <span
              className={`w-2 h-2 rounded-full ${
                isRecording ? "bg-red-500 animate-pulse" : "bg-slate-500"
              }`}
            />
            <span className="text-[10px] font-bold tracking-wider text-slate-400">
              {isConnecting ? "正在连接…" : isRecording ? "原文转写 (实时)" : "原文转写"}
            </span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto pr-1 scrollbar-thin transcript">
            {renderTranscript(originalBase, originalLive, isRecording, settings.fontSize, false)}
          </div>
        </section>

        {/* Translated */}
        <section className="flex-1 bg-slate-950 px-4 py-3 relative flex flex-col min-h-0">
          <div className="flex items-center justify-between mb-2 shrink-0">
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full ${
                  isRecording ? "bg-emerald-500 animate-pulse" : "bg-slate-600"
                }`}
              />
              <span className="text-[10px] font-bold tracking-wider text-slate-400">
                实时翻译 ({settings.targetLang})
              </span>
            </div>
            <button
              type="button"
              onClick={() => setAutoPlayAudio((v) => !v)}
              className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                autoPlayAudio
                  ? "text-indigo-300 bg-indigo-950/60 border-indigo-800/80"
                  : "text-slate-400 bg-slate-800 border-slate-700 hover:bg-slate-700"
              }`}
              title="翻译语音自动播放"
            >
              {autoPlayAudio ? (
                <Volume2 className="w-3 h-3 text-indigo-400" />
              ) : (
                <VolumeX className="w-3 h-3" />
              )}
              <span>{autoPlayAudio ? "开" : "关"}</span>
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto pr-1 scrollbar-thin transcript">
            {renderTranscript(translatedBase, translatedLive, isRecording, settings.fontSize, true)}
          </div>
        </section>
      </main>

      {/* Footer: only the mic button + status + volume + token counter.
          Entire row is a drag region; the mic button itself opts out. */}
      <footer
        className="drag-region py-2 px-3 bg-slate-900 border-t border-slate-800 flex items-center justify-center shrink-0 gap-3"
      >
        <button
          onClick={toggleRecording}
          disabled={isConnecting || !isWsConfigured}
          className={`no-drag w-14 h-14 rounded-full shrink-0 ${
            isRecording
              ? "bg-red-600 hover:bg-red-500 shadow-[0_0_35px_rgba(220,38,38,0.5)]"
              : "bg-blue-600 hover:bg-blue-500 shadow-[0_0_35px_rgba(37,99,235,0.5)]"
          } flex items-center justify-center border-4 border-slate-950 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed z-10`}
          title={
            isRecording
              ? "点击停止"
              : !isWsConfigured
                ? "请先在设置里填写 WebSocket 地址"
                : "点击开始实时翻译"
          }
        >
          {isConnecting ? (
            <Loader2 className="w-5 h-5 text-white animate-spin" />
          ) : isRecording ? (
            <Square className="w-4 h-4 text-white fill-current" />
          ) : (
            <Mic className="w-5 h-5 text-white" />
          )}
        </button>

        <div className="flex flex-col gap-1 min-w-0">
          <div
            className={`flex items-center gap-1.5 px-2 py-1 rounded-full border backdrop-blur transition-colors shrink-0 ${
              isRecording
                ? "bg-slate-950/80 border-slate-800"
                : "bg-red-950/40 border-red-900/60"
            }`}
          >
            {isRecording ? (
              <>
                <span className="text-[10px] text-blue-400 font-medium whitespace-nowrap">
                  麦克风已激活
                </span>
                <div className="flex items-end gap-0.5 h-3.5">
                  {[0, 1, 2, 3, 4].map((idx) => (
                    <div
                      key={idx}
                      ref={(el) => (volumeBarsRef.current[idx] = el)}
                      className={`w-0.5 bg-blue-${idx % 2 ? "400" : "500"} rounded-full h-2 transition-all duration-75`}
                    />
                  ))}
                </div>
              </>
            ) : (
              <>
                <span className="text-[10px] text-red-400 font-medium whitespace-nowrap">
                  麦克风已关闭
                </span>
                <div className="w-5 h-0.5 bg-red-500 rounded-full" />
              </>
            )}
          </div>

          {(isRecording || isConnecting || tokenUsage.input > 0 || tokenUsage.output > 0) && (
            <div
              className={`flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-mono whitespace-nowrap shrink-0 ${
                isRecording || isConnecting
                  ? "bg-slate-950/90 border-slate-700 text-slate-300"
                  : "bg-slate-900 border-slate-800 text-slate-500"
              }`}
            >
              <span className="text-slate-500">Tokens</span>
              <span className="text-slate-400">入</span>
              <span className="text-blue-300 font-semibold tabular-nums">
                {formatTokens(tokenUsage.input)}
              </span>
              <span className="text-slate-600">|</span>
              <span className="text-slate-400">出</span>
              <span className="text-emerald-300 font-semibold tabular-nums">
                {formatTokens(tokenUsage.output)}
              </span>
              <span className="text-slate-600">|</span>
              <span className="text-slate-400">合</span>
              <span className="text-white font-semibold tabular-nums">
                {formatTokens(tokenUsage.input + tokenUsage.output)}
              </span>
            </div>
          )}
        </div>
      </footer>

      {/* Settings modal */}
      {showSettings && (
        <SettingsModal
          settings={settings}
          updateSettings={updateSettings}
          updateSerialSettings={updateSerialSettings}
          onClearTokens={() => {
            clearTokenUsage();
            setTokenUsage({ input: 0, output: 0 });
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function renderTranscript(
  base: string,
  live: string,
  isRecording: boolean,
  fontSize: number,
  isTranslated: boolean,
): React.ReactNode {
  const combined = (base ? base + (live ? "\n\n" : "") : "") + live;
  if (!combined) {
    if (isRecording) {
      return (
        <div className="text-slate-500 italic flex items-center gap-2" style={{ fontSize: `${fontSize}px` }}>
          <span className="inline-block w-2 h-2 bg-slate-400 rounded-full animate-ping" />
          {isTranslated ? "翻译将实时显示在这里…" : "正在聆听…"}
        </div>
      );
    }
    return (
      <div className="text-slate-600 italic" style={{ fontSize: `${fontSize}px` }}>
        点击下方麦克风按钮开始实时同传。
      </div>
    );
  }
  return (
    <p
      className={`leading-relaxed whitespace-pre-wrap break-words transcript ${
        isTranslated ? "font-semibold" : "font-light"
      }`}
      style={{ fontSize: `${fontSize}px`, lineHeight: 1.4 }}
    >
      {isTranslated ? (
        <>
          <span className="bg-gradient-to-r from-slate-500 via-slate-400 to-slate-500 bg-clip-text text-transparent">
            {base}
          </span>
          {base && live ? "\n\n" : null}
          <span className="bg-gradient-to-r from-blue-400 via-indigo-300 to-purple-400 bg-clip-text text-transparent">
            {live}
          </span>
        </>
      ) : (
        <>
          <span className="text-slate-400">{base}</span>
          {base && live ? "\n\n" : null}
          <span className="text-slate-100">{live}</span>
        </>
      )}
      {isRecording && live && (
        <span
          className={`inline-block w-2 ml-1 ${
            isTranslated ? "bg-indigo-400" : "bg-blue-500"
          } animate-pulse align-middle`}
          style={{ height: `${fontSize * 0.7}px` }}
        />
      )}
    </p>
  );
}

function SerialSelect(props: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  renderLabel?: (v: string) => string;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] text-slate-400">{props.label}</span>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-xs text-slate-100 focus:outline-none focus:border-blue-500"
      >
        {props.options.map((opt) => (
          <option key={opt} value={opt} className="bg-slate-900 text-slate-100">
            {props.renderLabel ? props.renderLabel(opt) : opt}
          </option>
        ))}
      </select>
    </label>
  );
}

function SettingsModal(props: {
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  updateSerialSettings: (patch: Partial<Settings["serial"]>) => void;
  onClearTokens: () => void;
  onClose: () => void;
}) {
  const { settings, updateSettings, updateSerialSettings, onClearTokens, onClose } = props;

  // WS URL edit state lives in its own buffer so the user can finish typing
  // before we re-validate. `wsSaved` reflects what's persisted to disk so the
  // indicator is honest about whether the on-screen value has been written.
  const [wsDraft, setWsDraft] = useState(settings.wsUrl);
  const [wsSaved, setWsSaved] = useState(settings.wsUrl);
  const [wsSaving, setWsSaving] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);
  useEffect(() => {
    setWsDraft(settings.wsUrl);
    setWsSaved(settings.wsUrl);
  }, [settings.wsUrl]);

  const wsValidationError = validateWsUrl(wsDraft);
  const wsIsDirty = wsDraft.trim() !== wsSaved.trim();

  const handleSaveWs = async () => {
    const err = validateWsUrl(wsDraft);
    if (err) {
      setWsError(err);
      return;
    }
    setWsError(null);
    setWsSaving(true);
    try {
      const trimmed = wsDraft.trim();
      await saveConfig({ wsUrl: trimmed });
      updateSettings({ wsUrl: trimmed });
      setWsSaved(trimmed);
    } catch (e: any) {
      setWsError(`保存失败: ${e?.message ?? String(e)}`);
    } finally {
      setWsSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-950/50" onClick={onClose} />
      <div className="fixed top-12 right-4 z-50 w-[22rem] max-w-[calc(100vw-2rem)] bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-4 text-slate-100 max-h-[80vh] overflow-y-auto scrollbar-thin">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <SettingsIcon className="w-4 h-4 text-slate-400" />
            <h3 className="font-bold text-base">设置</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 w-7 h-7 rounded-full flex items-center justify-center"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* WebSocket URL — server endpoint the app connects to. Persisted to
            a JSON file in the OS app-data dir (NOT to the compiled binary). */}
        <div className="mb-4">
          <div className="flex items-baseline justify-between mb-1.5">
            <label className="text-xs font-semibold text-slate-200">
              WebSocket 地址
            </label>
            <span
              className={`text-[10px] font-mono ${
                wsSaved.trim() ? "text-emerald-300" : "text-amber-300"
              }`}
            >
              {wsSaved.trim() ? "已配置" : "未配置"}
            </span>
          </div>
          <input
            type="text"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            value={wsDraft}
            placeholder="wss://example.com:443/live"
            onChange={(e) => {
              setWsDraft(e.target.value);
              if (wsError) setWsError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && wsIsDirty && !wsValidationError) {
                e.preventDefault();
                handleSaveWs();
              }
            }}
            className={`w-full bg-slate-950 border rounded px-2 py-1.5 text-xs font-mono text-slate-100 focus:outline-none ${
              wsValidationError
                ? "border-red-500 focus:border-red-400"
                : wsIsDirty
                  ? "border-amber-500/70 focus:border-amber-400"
                  : "border-slate-700 focus:border-blue-500"
            }`}
          />
          {wsValidationError ? (
            <p className="mt-1 text-[10px] text-red-300 font-mono">{wsValidationError}</p>
          ) : wsError ? (
            <p className="mt-1 text-[10px] text-red-300 font-mono">{wsError}</p>
          ) : (
            <p className="mt-1 text-[10px] text-slate-500 font-mono">
              示例: wss://host:443/live（必须以 ws:// 或 wss:// 开头，带路径）
            </p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={handleSaveWs}
              disabled={!wsIsDirty || !!wsValidationError || wsSaving}
              className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded transition-colors ${
                !wsIsDirty || wsValidationError || wsSaving
                  ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                  : "bg-blue-700 hover:bg-blue-600 text-white border border-blue-800"
              }`}
            >
              {wsSaving ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : wsIsDirty ? (
                <Pencil className="w-3 h-3" />
              ) : (
                <Check className="w-3 h-3" />
              )}
              <span>{wsSaving ? "保存中…" : wsIsDirty ? "保存" : "已保存"}</span>
            </button>
            {wsIsDirty && !wsSaving && (
              <button
                type="button"
                onClick={() => setWsDraft(wsSaved)}
                className="text-[11px] text-slate-400 hover:text-white px-2 py-1 rounded hover:bg-slate-800"
              >
                撤销
              </button>
            )}
          </div>
        </div>

        {/* Source language */}
        <div className="mb-4">
          <div className="flex items-baseline justify-between mb-1.5">
            <label className="text-xs font-semibold text-slate-200">源语言</label>
            <span className="text-[10px] text-slate-400">
              默认 <span className="text-blue-300 font-mono">Auto</span>
            </span>
          </div>
          <select
            value={settings.sourceLang}
            onChange={(e) => updateSettings({ sourceLang: e.target.value })}
            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-blue-500"
          >
            {SOURCE_LANGUAGES.map((lang) => (
              <option key={lang} value={lang} className="bg-slate-900 text-slate-100">
                {lang === "Auto" ? `${lang} (自动检测)` : lang}
              </option>
            ))}
          </select>
        </div>

        {/* VAD silence */}
        <div className="mb-4">
          <div className="flex items-baseline justify-between mb-1.5">
            <label className="text-xs font-semibold text-slate-200">VAD 静默间隔</label>
            <span className="text-[10px] font-mono text-blue-300">{settings.silenceMs} ms</span>
          </div>
          <input
            type="range"
            min={RANGES.silenceMs.min}
            max={RANGES.silenceMs.max}
            step={RANGES.silenceMs.step}
            value={settings.silenceMs}
            onChange={(e) => updateSettings({ silenceMs: parseInt(e.target.value, 10) })}
            className="w-full accent-blue-500"
          />
          <div className="flex items-center justify-between text-[10px] text-slate-400 mt-1">
            <span>灵敏</span>
            <span className="text-slate-300">{vadLabelLocal(settings.silenceMs)}</span>
            <span>迟钝</span>
          </div>
        </div>

        {/* Font size */}
        <div className="mb-4">
          <div className="flex items-baseline justify-between mb-1.5">
            <label className="text-xs font-semibold text-slate-200">转写字号</label>
            <span className="text-[10px] font-mono text-blue-300">{settings.fontSize} px</span>
          </div>
          <input
            type="range"
            min={RANGES.fontSize.min}
            max={RANGES.fontSize.max}
            step={RANGES.fontSize.step}
            value={settings.fontSize}
            onChange={(e) => updateSettings({ fontSize: parseInt(e.target.value, 10) })}
            className="w-full accent-blue-500"
          />
          <div className="flex items-center justify-between text-[10px] text-slate-400 mt-1">
            <span>小</span>
            <span>大</span>
          </div>
        </div>

        {/* Reset */}
        <div className="pt-3 border-t border-slate-800 flex items-center justify-between gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => updateSettings(DEFAULT_SETTINGS)}
            className="text-[11px] text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 px-2 py-1 rounded transition-colors"
          >
            恢复默认
          </button>
          <button
            type="button"
            onClick={onClearTokens}
            className="text-[11px] text-amber-300 hover:text-white bg-amber-950/60 hover:bg-amber-800 border border-amber-800/70 px-2 py-1 rounded transition-colors flex items-center gap-1"
          >
            <Trash2 className="w-3 h-3" />
            <span>清零 Token</span>
          </button>
        </div>
        <p className="mt-2 text-[10px] text-slate-500 font-mono">
          通用设置自动保存到本地；WebSocket 地址写入
          <span className="text-slate-400"> %LOCALAPPDATA%\Live Translate\settings.json</span>
        </p>
      </div>
    </>
  );
}

function vadLabelLocal(ms: number): string {
  if (ms <= 250) return "灵敏(可能切碎句子)";
  if (ms <= 900) return "平衡(推荐)";
  return "迟钝(等待更久才断句)";
}