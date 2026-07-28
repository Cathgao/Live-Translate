import React, { useState, useEffect, useRef } from 'react';
import { Mic, Square, Loader2, AlertCircle, Volume2, VolumeX, RefreshCw, Download, Settings as SettingsIcon, X, Github, Sun, FileText } from 'lucide-react';
import { loadSettings, saveSettings, RANGES, vadLabel, DEFAULT_SETTINGS, SOURCE_LANGUAGES, loadTokenUsage, saveTokenUsage, clearTokenUsage } from './settings';

// --- Console Log Interceptor & Downloader ---
interface LogEntry {
  timestamp: string;
  level: string;
  msg: string;
}

const MAX_LOG_ENTRIES = 3000;
const logBuffer: LogEntry[] = [];

if (typeof window !== 'undefined' && !(window as any).__console_intercepted) {
  (window as any).__console_intercepted = true;
  const levels: ('log' | 'warn' | 'error' | 'info')[] = ['log', 'warn', 'error', 'info'];

  levels.forEach((level) => {
    const orig = (console as any)[level];
    (console as any)[level] = (...args: any[]) => {
      try {
        const timestamp = new Date().toISOString();
        const msg = args.map((arg) => {
          if (typeof arg === 'string') return arg;
          if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
          try {
            return JSON.stringify(arg);
          } catch (_) {
            return String(arg);
          }
        }).join(' ');
        logBuffer.push({ timestamp, level, msg });
        if (logBuffer.length > MAX_LOG_ENTRIES) {
          logBuffer.shift();
        }
      } catch (_) {}
      if (orig) {
        orig.apply(console, args);
      }
    };
  });

  window.addEventListener('error', (e) => {
    try {
      logBuffer.push({
        timestamp: new Date().toISOString(),
        level: 'error',
        msg: `[Uncaught Error] ${e.message} at ${e.filename}:${e.lineno}:${e.colno} ${e.error ? e.error.stack || '' : ''}`
      });
    } catch (_) {}
  });

  window.addEventListener('unhandledrejection', (e) => {
    try {
      logBuffer.push({
        timestamp: new Date().toISOString(),
        level: 'error',
        msg: `[Unhandled Rejection] ${e.reason ? (e.reason.stack || e.reason) : e.reason}`
      });
    } catch (_) {}
  });
}

function downloadConsoleLogs() {
  const header = `=== Browser Console Logs ===\nExport Time: ${new Date().toLocaleString()}\nUser Agent: ${navigator.userAgent}\nTotal Log Entries Captured: ${logBuffer.length}\n============================\n\n`;
  const body = logBuffer.length > 0
    ? logBuffer.map(e => `[${e.timestamp}] [${e.level.toUpperCase()}] ${e.msg}`).join('\n')
    : '[No console logs captured yet]';
  const blob = new Blob([header + body], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `browser-console-logs-${dateStr}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const PCM_MIME_TYPE = 'audio/pcm;rate=16000';
const CHUNK_SAMPLES = 1600; // 100 ms @ 16 kHz

class AudioRecorderManager {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private dummyGainNode: GainNode | null = null;
  private sampleAcc: Int16Array = new Int16Array(0);

  private onChunkCallback: ((base64: string, mimeType: string) => void) | null = null;
  private onVolumeCallback: ((vol: number) => void) | null = null;
  private lastLogTime: number = 0;
  private watchdogTimer: number | null = null;
  private lastWorkletMsgTime: number = Date.now();

  async start(
    onChunkAvailable: (base64: string, mimeType: string) => void,
    onVolume?: (vol: number) => void,
  ) {
    this.onChunkCallback = onChunkAvailable;
    this.onVolumeCallback = onVolume ?? null;
    this.sampleAcc = new Int16Array(0);
    this.lastWorkletMsgTime = Date.now();

    console.log('[mic] requesting getUserMedia...');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    console.log('[mic] OK, tracks=', this.stream.getTracks().map(t => t.kind + ':' + t.readyState).join(','));

    // Handle track mute/unmute events from Android OS/browser power management
    const audioTrack = this.stream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.onmute = () => {
        console.warn('[mic track] OS/browser muted microphone track');
      };
      audioTrack.onunmute = () => {
        console.log('[mic track] OS/browser unmuted microphone track');
        this.resumeIfSuspended();
      };
      audioTrack.onended = () => {
        console.warn('[mic track] microphone track ended');
      };
    }

    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioCtx({ sampleRate: 16000 });

    // Handle statechange (auto-resume if suspended by mobile OS or browser)
    this.audioContext.onstatechange = () => {
      console.log('[mic] AudioContext state changed:', this.audioContext?.state);
      this.resumeIfSuspended();
    };

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    await this.audioContext.audioWorklet.addModule('/pcm-worklet.js');

    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-sender-processor');

    this.workletNode.onprocessorerror = (ev) => {
      console.error('[mic worklet] processor error:', ev);
    };

    this.workletNode.port.onmessage = (ev: MessageEvent) => {
      this.lastWorkletMsgTime = Date.now();
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === 'pcm') {
        this.handlePcm(new Int16Array(msg.buffer));
      } else if (msg.type === 'volume') {
        if (this.onVolumeCallback) this.onVolumeCallback(msg.value);
      }
    };

    this.sourceNode.connect(this.workletNode);

    // CRITICAL for Android / mobile browsers:
    // Connect workletNode to AudioContext destination via a GainNode with gain=0.
    // Without output connection to destination, Android Chrome optimizes the audio graph away
    // and suspends rendering after a prolonged period of silence!
    this.dummyGainNode = this.audioContext.createGain();
    this.dummyGainNode.gain.value = 0;
    this.workletNode.connect(this.dummyGainNode);
    this.dummyGainNode.connect(this.audioContext.destination);

    this.startWatchdog();

    console.log('[mic] started streaming — worklet active, connected to destination via dummy gain');
  }

  public async resumeIfSuspended() {
    if (
      this.audioContext &&
      (this.audioContext.state === 'suspended' || (this.audioContext as any).state === 'interrupted')
    ) {
      console.log('[mic] resuming suspended AudioContext...');
      try {
        await this.audioContext.resume();
      } catch (e) {
        console.warn('[mic] resume failed:', e);
      }
    }
  }

  /**
   * Drop the in-progress PCM accumulator so the next chunk the worklet emits
   * does not include stale samples that pre-date a server-side upstream reset.
   * The AudioContext / mic stream / worklet keep running — only the buffered
   * tail is discarded.
   */
  public reset() {
    this.sampleAcc = new Int16Array(0);
    this.lastWorkletMsgTime = Date.now();
    console.log('[mic] recorder buffer reset (sampleAcc cleared)');
  }

  private startWatchdog() {
    this.stopWatchdog();
    this.watchdogTimer = window.setInterval(async () => {
      if (!this.audioContext) return;

      if (
        this.audioContext.state === 'suspended' ||
        (this.audioContext as any).state === 'interrupted'
      ) {
        console.warn(`[mic watchdog] AudioContext is ${this.audioContext.state}, attempting resume...`);
        await this.resumeIfSuspended();
      }

      // Check if worklet has stalled (no messages received for > 2.5s)
      const silenceDuration = Date.now() - this.lastWorkletMsgTime;
      if (silenceDuration > 2500) {
        console.warn(`[mic watchdog] No worklet messages for ${silenceDuration}ms. Re-kicking AudioContext...`);
        try {
          if (this.audioContext.state === 'running') {
            await this.audioContext.suspend();
            await this.audioContext.resume();
          } else {
            await this.audioContext.resume();
          }
        } catch (_) {}
      }
    }, 1500);
  }

  private stopWatchdog() {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private handlePcm(incoming: Int16Array) {
    const merged = new Int16Array(this.sampleAcc.length + incoming.length);
    merged.set(this.sampleAcc, 0);
    merged.set(incoming, this.sampleAcc.length);

    let offset = 0;
    let emitted = 0;
    while (merged.length - offset >= CHUNK_SAMPLES) {
      const slice = merged.subarray(offset, offset + CHUNK_SAMPLES);
      const ab = new ArrayBuffer(slice.length * 2);
      const view = new DataView(ab);
      for (let i = 0; i < slice.length; i++) {
        view.setInt16(i * 2, slice[i], true); // little-endian Int16
      }
      if (this.onChunkCallback) {
        this.onChunkCallback(arrayBufferToBase64(ab), PCM_MIME_TYPE);
      }
      offset += CHUNK_SAMPLES;
      emitted++;
    }

    this.sampleAcc = merged.subarray(offset);

    if (emitted > 0) {
      const now = Date.now();
      if (!this.lastLogTime || now - this.lastLogTime > 2000) {
        console.log(`[worklet] emitted ${emitted} chunk(s) in this tick (${emitted * 100}ms of audio)`);
        this.lastLogTime = now;
      }
    }
  }

  stop() {
    this.stopWatchdog();
    if (this.workletNode) {
      try { this.workletNode.port.postMessage({ type: 'stop' }); } catch (_) {}
      try { this.workletNode.disconnect(); } catch (_) {}
    }
    if (this.dummyGainNode) {
      try { this.dummyGainNode.disconnect(); } catch (_) {}
    }
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch (_) {}
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
    }
    this.stream = null;
    this.workletNode = null;
    this.sourceNode = null;
    this.dummyGainNode = null;
    this.audioContext = null;
    this.sampleAcc = new Int16Array(0);
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)) as any);
  }
  return btoa(binary);
}

class TranslationAudioPlayer {
  private audioContext: AudioContext | null = null;
  private nextStartTime: number = 0;
  private muted: boolean = false;

  setMuted(m: boolean) { this.muted = m; }

  private ensureContext(): AudioContext {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioCtx({ sampleRate: 24000 });
    }
    return this.audioContext;
  }

  enqueue(base64Pcm: string) {
    if (this.muted) return;
    if (!base64Pcm) return;
    try {
      const ctx = this.ensureContext();
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      const raw = atob(base64Pcm);
      const byteLen = raw.length;
      const buffer = new ArrayBuffer(byteLen - (byteLen % 2));
      const view = new DataView(buffer);
      for (let i = 0; i < byteLen - 1; i += 2) {
        view.setInt16(i, (raw.charCodeAt(i + 1) << 8) | raw.charCodeAt(i), true);
      }
      const int16 = new Int16Array(buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
      }

      const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
      audioBuffer.copyToChannel(float32, 0);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const now = ctx.currentTime;
      const startAt = Math.max(now + 0.02, this.nextStartTime);
      source.start(startAt);
      this.nextStartTime = startAt + audioBuffer.duration;
    } catch (e) {
      console.error('[translation audio] enqueue failed', e);
    }
  }

  stop() {
    if (this.audioContext) {
      try { this.audioContext.close(); } catch (_) {}
    }
    this.audioContext = null;
    this.nextStartTime = 0;
  }
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  return `${(n / 1000).toFixed(1)}k`;
}

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const [targetLang, setTargetLang] = useState('Chinese (Simplified)');

  const [originalBase, setOriginalBase] = useState('');
  const [translatedBase, setTranslatedBase] = useState('');
  const [originalLive, setOriginalLive] = useState('');
  const [translatedLive, setTranslatedLive] = useState('');

  const [error, setError] = useState('');
  const [showSysPermissionGuide, setShowSysPermissionGuide] = useState(false);
  const [autoPlayAudio, setAutoPlayAudio] = useState(false); // OFF by default

  const [settings, setSettings] = useState(() => loadSettings());
  const sourceLang = settings.sourceLang;
  const [showSettings, setShowSettings] = useState(false);

  const [tokenUsage, setTokenUsageState] = useState(() => loadTokenUsage());
  const setTokenUsage = (u: { input: number; output: number }) => {
    setTokenUsageState(u);
    saveTokenUsage(u);
  };

  const updateSettings = (patch: Partial<typeof settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  };

  const wsRef = useRef<WebSocket | null>(null);
  const audioRecorderRef = useRef<AudioRecorderManager | null>(null);
  const translationPlayerRef = useRef<TranslationAudioPlayer | null>(null);

  const pendingOrigRef = useRef<string>('');
  const pendingTransRef = useRef<string>('');
  const segmentCommitTimer = useRef<NodeJS.Timeout | null>(null);

  // Read SEGMENT_COMMIT_MS from Vite env (VITE_SEGMENT_COMMIT_MS).
  // Falls back to 5000ms when missing or invalid.
  const parseSegmentCommitMs = (raw: unknown): number => {
    if (raw == null || raw === '') return 5000;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 5000;
    return n;
  };
  const SEGMENT_COMMIT_MS = parseSegmentCommitMs(import.meta.env.VITE_SEGMENT_COMMIT_MS);

  const [reconnectStatus, setReconnectStatus] = useState('');
  const userStoppedRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const MAX_RECONNECT_ATTEMPTS = 10;

  const scrollRefTop = useRef<HTMLDivElement>(null);
  const scrollRefBottom = useRef<HTMLDivElement>(null);
  const volumeBarsRef = useRef<(HTMLDivElement | null)[]>([]);

  const wakeLockSentinelRef = useRef<any>(null);
  const [isKeepAwakeActive, setIsKeepAwakeActive] = useState(false);

  const requestKeepAwake = async () => {
    if (!settings.preventSleep) return;
    try {
      if ('wakeLock' in navigator) {
        const sentinel = await (navigator as any).wakeLock.request('screen');
        wakeLockSentinelRef.current = sentinel;
        setIsKeepAwakeActive(true);
        console.log('[wakeLock] Screen wake lock acquired via Screen Wake Lock API');
        sentinel.addEventListener('release', () => {
          console.log('[wakeLock] Screen wake lock released');
          setIsKeepAwakeActive(false);
          wakeLockSentinelRef.current = null;
        });
      }
    } catch (err) {
      console.warn('[wakeLock] navigator.wakeLock failed:', err);
    }
  };

  const releaseKeepAwake = async () => {
    if (wakeLockSentinelRef.current) {
      try {
        await wakeLockSentinelRef.current.release();
      } catch (_) {}
      wakeLockSentinelRef.current = null;
    }
    setIsKeepAwakeActive(false);
  };

  const LANGUAGES = SOURCE_LANGUAGES;

  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (isRecording && settings.preventSleep && document.visibilityState === 'visible') {
        if (!wakeLockSentinelRef.current) {
          await requestKeepAwake();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isRecording, settings.preventSleep]);

  useEffect(() => {
    if (isRecording) {
      if (settings.preventSleep) {
        requestKeepAwake();
      } else {
        releaseKeepAwake();
      }
    } else {
      releaseKeepAwake();
    }
  }, [isRecording, settings.preventSleep]);

  useEffect(() => {
    const el = scrollRefTop.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [originalBase, originalLive]);

  useEffect(() => {
    const el = scrollRefBottom.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [translatedBase, translatedLive]);

  const toggleRecording = async () => {
    console.log(`[diag] CLIENT BUILD: segmentCommit=${SEGMENT_COMMIT_MS}ms, env=`, import.meta.env.VITE_SEGMENT_COMMIT_MS);
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  const startRecording = async () => {
    setError('');
    setReconnectStatus('');
    userStoppedRef.current = false;
    reconnectAttemptsRef.current = 0;
    setIsConnecting(true);
    setOriginalLive('');
    setTranslatedLive('');
    pendingOrigRef.current = '';
    pendingTransRef.current = '';
    if (segmentCommitTimer.current) {
      clearTimeout(segmentCommitTimer.current);
      segmentCommitTimer.current = null;
    }

    connectWebSocket();
  };

  const connectWebSocket = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/live?source=${encodeURIComponent(sourceLang)}&target=${encodeURIComponent(targetLang)}&silenceMs=${encodeURIComponent(String(settings.silenceMs))}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;
    } catch (e: any) {
      setError(`WebSocket 连接初始化失败: ${e.message}`);
      setIsConnecting(false);
      return;
    }

    ws.onopen = async () => {
      console.log('[ws] connected to live translation server');
      reconnectAttemptsRef.current = 0;
      setReconnectStatus('');
      setError('');

      if (!translationPlayerRef.current) {
        const player = new TranslationAudioPlayer();
        player.setMuted(!autoPlayAudio);
        translationPlayerRef.current = player;
      }

      // If mic is already running (e.g. during auto-reconnect), don't re-initialize
      if (!audioRecorderRef.current) {
        try {
          const recorder = new AudioRecorderManager();
          audioRecorderRef.current = recorder;

          await recorder.start(
            (base64Audio, mimeType) => {
              if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ audioBlob: base64Audio, mimeType }));
              }
            },
            (vol) => {
              volumeBarsRef.current.forEach((bar, idx) => {
                if (bar) {
                  const multiplier = 1 + (idx % 3) * 0.4;
                  bar.style.height = `${Math.max(4, vol * 60 * multiplier)}px`;
                }
              });
            },
          );
        } catch (micErr: any) {
          const errName = micErr?.name || 'Error';
          const errMsg = micErr?.message || String(micErr);
          console.warn('[mic] access issue:', errName, errMsg);

          setIsConnecting(false);
          if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError' || errMsg.includes('Permission')) {
            setError(`麦克风已被操作系统级隐私策略拒绝 (${errName}: ${errMsg})。`);
            setShowSysPermissionGuide(true);
          } else if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
            setError(`未找到麦克风设备 (${errName})。`);
          } else {
            setError(`麦克风启动失败 (${errName}: ${errMsg})。`);
          }
          stopRecording();
          return;
        }
      }

      setIsConnecting(false);
      setIsRecording(true);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'ping') {
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'pong' }));
          }
          return;
        }

        // upstream_goaway: 预告。如果当前 UI 没有挂起的段落（pending 已空，
        // 即上一次 commit 已经完成），立刻发 commit 让服务端在段尾切。
        // 否则等 5s 静默兜底 timer 触发 flushPending('timer') 时再发。
        if (msg.type === 'upstream_goaway') {
          console.log('[upstream_goaway] timeLeft=', msg.timeLeft);
          const pendingEmpty =
            pendingOrigRef.current.trim() === '' &&
            pendingTransRef.current.trim() === '';
          if (pendingEmpty) {
            console.log('[upstream_goaway] pending empty; signaling commit immediately');
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({ action: 'commit' }));
            }
          } else {
            console.log('[upstream_goaway] pending non-empty; waiting for next 5s silence to commit');
          }
          return;
        }

        const kind = msg.type || (msg.error ? 'error' : 'unknown');
        if (kind !== 'transcription' && kind !== 'translation_audio' && kind !== 'transcription_finished') {
          console.log('[ws recv]', kind, Object.keys(msg).join(','));
        }

        const flushPending = (reason: string) => {
          console.log(`[commit] flush reason=${reason} orig=${JSON.stringify(pendingOrigRef.current)} trans=${JSON.stringify(pendingTransRef.current)}`);
          const finalOrig = pendingOrigRef.current.trim();
          const finalTrans = pendingTransRef.current.trim();
          if (finalOrig) {
            setOriginalBase((prev) => (prev ? prev + '\n\n' : '') + finalOrig);
          }
          if (finalTrans) {
            setTranslatedBase((prev) => (prev ? prev + '\n\n' : '') + finalTrans);
          }
          pendingOrigRef.current = '';
          pendingTransRef.current = '';
          setOriginalLive('');
          setTranslatedLive('');
          if (segmentCommitTimer.current) {
            clearTimeout(segmentCommitTimer.current);
            segmentCommitTimer.current = null;
          }
          // 仅当 UI 静默定时器主动 commit（reason='timer'）时通知 server。
          // 'finished' / 'upstream_reset' 路径下 server 已知道，不需要重复。
          // server 端只有在 GoAway 窗口内才会真正处理这个信号。
          if (reason === 'timer' && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ action: 'commit' }));
          }
        };

        const armSilenceCommit = () => {
          if (segmentCommitTimer.current) clearTimeout(segmentCommitTimer.current);
          segmentCommitTimer.current = setTimeout(() => {
            console.log(`[commit] timer fired (${SEGMENT_COMMIT_MS}ms)`);
            segmentCommitTimer.current = null;
            flushPending('timer');
          }, SEGMENT_COMMIT_MS);
        };

        // upstream_reset: server just rotated its Gemini Live upstream
        // (GoAway / 10-min session limit). The WS itself is still alive — we
        // only need to drop recorder-buffer state and flush any pending
        // transcription so the visible transcript stays continuous.
        if (msg.type === 'upstream_reset') {
          console.log('[upstream_reset] server rotated upstream; flushing pending transcript and clearing recorder buffer');
          flushPending('upstream_reset');
          audioRecorderRef.current?.reset();
          setReconnectStatus('上游会话已自动重置…');
          // Clear the soft banner after a short display window so it doesn't linger.
          setTimeout(() => {
            setReconnectStatus((cur) => (cur === '上游会话已自动重置…' ? '' : cur));
          }, 2500);
          return;
        }

        if (msg.type === 'transcription') {
          const origDelta = msg.originalText || '';
          const transDelta = msg.translatedText || '';
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
          const hasMeaningfulDelta = origDelta.trim() !== '' || transDelta.trim() !== '';
          if (hasMeaningfulDelta) {
            console.log(`[commit] arm timer; pending orig=${JSON.stringify(pendingOrigRef.current)} trans=${JSON.stringify(pendingTransRef.current)}`);
            setOriginalLive(pendingOrigRef.current);
            setTranslatedLive(pendingTransRef.current);
            armSilenceCommit();
          } else {
            console.log(`[commit] skip arm timer (no meaningful delta); pending orig=${JSON.stringify(pendingOrigRef.current)} trans=${JSON.stringify(pendingTransRef.current)}`);
          }
          return;
        }

        if (msg.type === 'transcription_finished') {
          flushPending('finished');
          return;
        }

        if (msg.type === 'transcription_interrupted') {
          pendingOrigRef.current = '';
          pendingTransRef.current = '';
          setOriginalLive('');
          setTranslatedLive('');
          if (segmentCommitTimer.current) {
            clearTimeout(segmentCommitTimer.current);
            segmentCommitTimer.current = null;
          }
          return;
        }

        if (msg.type === 'translation_audio' && msg.audio) {
          translationPlayerRef.current?.enqueue(msg.audio);
          return;
        }

        if (msg.type === 'usage') {
          setTokenUsage({
            input: msg.inputTokens || 0,
            output: msg.outputTokens || 0,
          });
          return;
        }

        if (msg.error) {
          setError(msg.error);
          stopRecording();
          return;
        }
      } catch (e) {
        console.error('[ws] parse error:', e);
      }
    };

    ws.onerror = (ev) => {
      console.warn('[ws error event]:', ev);
    };

    ws.onclose = (ev) => {
      console.log(`[ws close] code=${ev.code}, userStopped=${userStoppedRef.current}`);
      if (userStoppedRef.current) {
        return;
      }
      handleAutoReconnect();
    };
  };

  const handleAutoReconnect = () => {
    if (userStoppedRef.current) return;

    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      setError('跨国网络连接中断且多次重连失败，请检查网络后重新开始');
      setReconnectStatus('');
      stopRecording();
      return;
    }

    reconnectAttemptsRef.current += 1;
    const attempt = reconnectAttemptsRef.current;
    const delay = Math.min(1000 * Math.pow(1.3, attempt - 1), 5000);

    setReconnectStatus(`网络线路闪断，正在自动重新连接 (${attempt}/${MAX_RECONNECT_ATTEMPTS})...`);
    console.warn(`[ws reconnect] Network break. Scheduling reconnect #${attempt} in ${Math.round(delay)}ms`);

    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      if (!userStoppedRef.current) {
        connectWebSocket();
      }
    }, delay);
  };

  const stopRecording = () => {
    userStoppedRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setReconnectStatus('');
    setIsRecording(false);
    setIsConnecting(false);

    if (wsRef.current) {
      try {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ action: 'flush' }));
        }
        wsRef.current.close();
      } catch (_) {}
      wsRef.current = null;
    }

    if (audioRecorderRef.current) {
      audioRecorderRef.current.stop();
      audioRecorderRef.current = null;
    }

    if (translationPlayerRef.current) {
      translationPlayerRef.current.stop();
      translationPlayerRef.current = null;
    }

    if (segmentCommitTimer.current) {
      clearTimeout(segmentCommitTimer.current);
      segmentCommitTimer.current = null;
    }
  };

  const handleSpeakTranslatedText = () => {
    const last = (translatedLive || translatedBase).trim();
    if (!last) return;

    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }

    if (!('speechSynthesis' in window)) {
      setError('当前浏览器不支持语音合成。');
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(last);
    const langMap: Record<string, string> = {
      'English': 'en-US',
      'Chinese (Simplified)': 'zh-CN',
      'Spanish': 'es-ES',
      'French': 'fr-FR',
      'Japanese': 'ja-JP',
      'Korean': 'ko-KR',
      'German': 'de-DE'
    };
    utterance.lang = langMap[targetLang] || 'zh-CN';
    utterance.rate = 1.0;

    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);

    window.speechSynthesis.speak(utterance);
  };

  const handleSaveTranscript = () => {
    const origFull = (originalBase + (originalLive ? (originalBase ? ' ' : '') + originalLive : '')).trim();
    const transFull = (translatedBase + (translatedLive ? (translatedBase ? ' ' : '') + translatedLive : '')).trim();
    if (!origFull && !transFull) {
      setError('当前没有任何转写或翻译内容，无法保存。');
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const header = [
      `Gemini 实时同传 — 保存的会话记录`,
      `保存时间: ${new Date().toLocaleString()}`,
      `源语言: ${sourceLang}    目标语言: ${targetLang}`,
      `Token 累计(本次保存时刻): 入 ${tokenUsage.input} · 出 ${tokenUsage.output} · 合计 ${tokenUsage.input + tokenUsage.output}`,
      '=' .repeat(60),
      '',
    ].join('\n');

    const body = [
      '【原文转写】',
      origFull || '(无)',
      '',
      '【中文翻译】',
      transFull || '(无)',
      '',
    ].join('\n');

    const blob = new Blob(['\uFEFF' + header + body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `live-translate-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="w-full h-full bg-slate-950 flex flex-col font-sans text-slate-100 overflow-hidden">
      <nav className="h-16 flex items-center justify-between px-6 md:px-8 bg-slate-900/80 border-b border-slate-800 shrink-0 backdrop-blur">
        <div className="flex items-center gap-3">
          <img
            src="/translation.png"
            alt="translation logo"
            className="w-8 h-8 rounded-lg object-cover shadow-md"
          />
          <span className="font-bold text-base md:text-lg tracking-tight">Gemini 实时同传</span>
        </div>

        <div className="flex items-center gap-3 md:gap-4">
          {/* Target Language Selector */}
          <div className="flex items-center gap-2 bg-slate-800/90 px-3 py-1.5 rounded-full border border-slate-700 shadow-md text-xs md:text-sm">
            <select
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              disabled={isRecording || isConnecting}
              className="bg-transparent font-medium focus:outline-none cursor-pointer text-slate-100 disabled:opacity-50 appearance-none"
              title="目标语言"
            >
              {LANGUAGES.filter(l => l !== 'Auto').map(lang => <option key={lang} value={lang} className="bg-slate-800 text-slate-100">{lang}</option>)}
            </select>
          </div>

          {/* GitHub link */}
          <a
            href="https://github.com/Cathgao/Live-Translate"
            target="_blank"
            rel="noopener noreferrer"
            className="relative w-9 h-9 rounded-full border flex items-center justify-center transition-colors bg-slate-800/90 hover:bg-slate-700 border-slate-700 text-slate-300 hover:text-white"
            title="GitHub 仓库"
            aria-label="GitHub 仓库"
          >
            <Github className="w-4 h-4" />
          </a>

          {/* Settings (gear) */}
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className={`relative w-9 h-9 rounded-full border flex items-center justify-center transition-colors ${
              showSettings
                ? 'bg-slate-700 border-slate-500 text-white'
                : 'bg-slate-800/90 hover:bg-slate-700 border-slate-700 text-slate-300 hover:text-white'
            }`}
            title="设置"
            aria-label="设置"
          >
            <SettingsIcon className="w-4 h-4" />
          </button>
        </div>
      </nav>

      {/* Settings Panel (floating popover, anchored to top-right) */}
      {showSettings && (
        <>
          {/* click-away backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setShowSettings(false)}
          />
          <div className="fixed top-20 right-6 md:right-8 z-50 w-[20rem] max-w-[calc(100vw-3rem)] bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5 text-slate-100">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <SettingsIcon className="w-4 h-4 text-slate-400" />
                <h3 className="font-bold text-base">设置</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowSettings(false)}
                className="text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 w-7 h-7 rounded-full flex items-center justify-center"
                aria-label="关闭"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* VAD 静默间隔 */}
            <div className="mb-5">
              <div className="flex items-baseline justify-between mb-1.5">
                <label className="text-sm font-semibold text-slate-200">
                  VAD 静默间隔
                </label>
                <span className="text-xs font-mono text-blue-300">
                  {settings.silenceMs} ms
                </span>
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
              <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
                <span>灵敏</span>
                <span className="text-slate-300">{vadLabel(settings.silenceMs)}</span>
                <span>迟钝</span>
              </div>
              <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                服务端识别静音多久后判定一句话结束。在下次新建连接时生效。
              </p>
            </div>

            {/* 源语言 */}
            <div className="mb-5">
              <div className="flex items-baseline justify-between mb-1.5">
                <label className="text-sm font-semibold text-slate-200">
                  源语言
                </label>
                <span className="text-[11px] text-slate-400">
                  默认 <span className="text-blue-300 font-mono">Auto</span>(自动检测)
                </span>
              </div>
              <select
                value={settings.sourceLang}
                onChange={(e) => updateSettings({ sourceLang: e.target.value })}
                disabled={isRecording || isConnecting}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500 cursor-pointer disabled:opacity-50"
                title="源语言(Auto 表示由 Gemini 自动检测)"
              >
                {LANGUAGES.map(lang => (
                  <option key={lang} value={lang} className="bg-slate-900 text-slate-100">
                    {lang === 'Auto' ? `${lang} (自动检测)` : lang}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                指定说话语言或交给模型自动判断。在下次新建连接时生效。
              </p>
            </div>

            {/* 字号 */}
            <div className="mb-5">
              <div className="flex items-baseline justify-between mb-1.5">
                <label className="text-sm font-semibold text-slate-200">
                  转写字号
                </label>
                <span className="text-xs font-mono text-blue-300">
                  {settings.fontSize} px
                </span>
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
              <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
                <span>小</span>
                <span>大</span>
              </div>
              <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                立即生效,适用于原文与译文两栏。
              </p>
            </div>

            {/* 麦克风开启时常亮防待机锁屏 */}
            <div className="mb-2">
              <div className="flex items-center justify-between">
                <div className="flex flex-col pr-2">
                  <span className="text-sm font-semibold text-slate-200 flex items-center gap-1.5">
                    <Sun className="w-4 h-4 text-amber-400" />
                    屏幕常亮
                  </span>
                  <span className="text-[11px] text-slate-400 mt-0.5 leading-tight">
                    开启麦克风时阻止手机屏幕自动熄屏锁屏
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => updateSettings({ preventSleep: !settings.preventSleep })}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                    settings.preventSleep ? 'bg-amber-500' : 'bg-slate-700'
                  }`}
                  title="切换麦克风开启时屏幕常亮"
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      settings.preventSleep ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => {
                    updateSettings(DEFAULT_SETTINGS);
                  }}
                  className="text-xs text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-lg transition-colors"
                >
                  恢复默认
                </button>
                <button
                  type="button"
                  onClick={() => {
                    clearTokenUsage();
                    setTokenUsage({ input: 0, output: 0 });
                  }}
                  disabled={tokenUsage.input === 0 && tokenUsage.output === 0}
                  className="text-xs text-amber-300 hover:text-white bg-amber-950/60 hover:bg-amber-800 border border-amber-800/70 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-amber-950/60 disabled:hover:text-amber-300 px-3 py-1.5 rounded-lg transition-colors"
                  title="把累计 token 计数清零"
                >
                  清零 Token
                </button>
                <button
                  type="button"
                  onClick={downloadConsoleLogs}
                  className="p-1.5 text-sky-300 hover:text-white bg-sky-950/60 hover:bg-sky-800 border border-sky-800/70 rounded-lg transition-colors flex items-center justify-center"
                  title="下载控制台日志 (.txt)"
                  aria-label="下载控制台日志"
                >
                  <FileText className="w-4 h-4 text-sky-400" />
                </button>
              </div>
              <span className="text-[10px] text-slate-500 font-mono">
                自动保存到本地
              </span>
            </div>
          </div>
        </>
      )}

      {/* Main Container */}
      <main className="flex-1 flex flex-col h-0 relative">
        {reconnectStatus && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-amber-950/95 text-amber-100 px-5 py-3 rounded-2xl shadow-2xl text-xs md:text-sm font-medium backdrop-blur-md flex items-center gap-3 max-w-xl border border-amber-500/80 animate-pulse">
            <RefreshCw className="w-5 h-5 shrink-0 text-amber-400 animate-spin" />
            <div className="flex-1 leading-relaxed">{reconnectStatus}</div>
          </div>
        )}

        {error && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-red-900/95 text-white px-5 py-3.5 rounded-2xl shadow-2xl text-sm font-medium backdrop-blur-md flex items-center gap-3 max-w-2xl border border-red-500/80">
            <AlertCircle className="w-6 h-6 shrink-0 text-red-400" />
            <div className="flex-1 text-xs md:text-sm leading-relaxed overflow-hidden">
              <span className="font-bold text-red-200 block mb-0.5">错误提示</span>
              <p className="break-words font-mono text-xs opacity-95">{error}</p>
            </div>
            <button
              onClick={() => setError('')}
              className="bg-red-800 hover:bg-red-700 text-red-100 font-bold px-3 py-1 rounded-lg text-xs"
            >
              关闭
            </button>
          </div>
        )}

        {/* System Microphone Permission Troubleshooting Modal */}
        {showSysPermissionGuide && (
          <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full p-6 md:p-8 text-slate-100 shadow-2xl relative max-h-[90vh] overflow-y-auto">
              <button
                onClick={() => setShowSysPermissionGuide(false)}
                className="absolute top-4 right-4 text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 w-8 h-8 rounded-full flex items-center justify-center font-bold text-lg"
              >
                ✕
              </button>

              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0 text-amber-400">
                  <AlertCircle className="w-6 h-6" />
                </div>
                <div>
                  <h2 className="text-lg md:text-xl font-bold text-white">系统麦克风权限被阻断</h2>
                  <p className="text-xs text-amber-300 font-mono">NotAllowedError: Permission denied by system</p>
                </div>
              </div>

              <div className="bg-slate-800/80 rounded-xl p-4 border border-slate-700/80 mb-6 text-xs md:text-sm text-slate-300 space-y-2">
                <p>
                  浏览器网站权限（地址栏锁状图标）虽然已开启，但<strong className="text-amber-300"> Windows / macOS 操作系统的全局隐私开关 </strong>禁用了浏览器访问硬件麦克风。请按以下方法开启：
                </p>
              </div>

              <div className="space-y-6 text-sm text-slate-200">
                <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800">
                  <h3 className="font-bold text-blue-400 flex items-center gap-2 mb-2">
                    <span className="px-2 py-0.5 rounded bg-blue-500/20 text-xs text-blue-300">Windows 用户</span>
                    Windows 隐私设置开启方法：
                  </h3>
                  <ol className="list-decimal list-inside space-y-2 text-xs md:text-sm text-slate-300">
                    <li>按 <kbd className="bg-slate-800 text-slate-100 px-2 py-0.5 rounded text-xs border border-slate-700 font-mono">Win + i</kbd> 打开<strong>系统设置</strong>。</li>
                    <li>左侧点击<strong>「隐私和安全性」</strong>，下滑点击<strong>「麦克风」</strong>。</li>
                    <li>确保顶部<strong>「允许应用访问麦克风」</strong>处于<strong>开启 (ON)</strong> 状态。</li>
                    <li>确保下方<strong>「允许桌面应用访问麦克风」</strong>处于<strong>开启 (ON)</strong> 状态（包含 Edge / Chrome）。</li>
                    <li>如仍不行，请检查 Zoom / Teams / OBS 是否正在独占麦克风设备。</li>
                  </ol>
                </div>

                <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800">
                  <h3 className="font-bold text-emerald-400 flex items-center gap-2 mb-2">
                    <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-xs text-emerald-300">macOS 用户</span>
                    Mac 隐私设置开启方法：
                  </h3>
                  <ol className="list-decimal list-inside space-y-2 text-xs md:text-sm text-slate-300">
                    <li>点击左上角 <strong>  </strong> -&gt; 打开<strong>「系统设置」</strong>。</li>
                    <li>点击<strong>「隐私与安全性」</strong>-&gt; 选择<strong>「麦克风」</strong>。</li>
                    <li>确保勾选允许 <strong>Google Chrome</strong> 或 <strong>Microsoft Edge</strong> 使用麦克风。</li>
                  </ol>
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-slate-800 flex items-center justify-end gap-3">
                <button
                  onClick={() => {
                    setShowSysPermissionGuide(false);
                    startRecording();
                  }}
                  className="bg-blue-600 hover:bg-blue-500 text-white font-bold px-4 py-2 rounded-xl text-xs md:text-sm transition-colors flex items-center gap-2"
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>已修改，重新尝试麦克风</span>
                </button>
                <button
                  onClick={() => setShowSysPermissionGuide(false)}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-xl text-xs md:text-sm transition-colors"
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Top Half: Original Spoken Text — accumulating turns */}
        <section className="flex-1 bg-slate-900/90 p-6 md:p-10 relative border-b border-slate-800/80 flex flex-col min-h-0">
          <div className="max-w-4xl w-full mx-auto flex-1 flex flex-col min-h-0">
            <div className="flex items-center gap-2 mb-4 shrink-0">
              <span className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-slate-500'}`}></span>
              <span className="text-xs font-bold tracking-wider text-slate-400">
                {isConnecting ? '正在连接…' : isRecording ? '正在识别语音 (实时转写)' : '原文转写'}
              </span>
            </div>

            <div ref={scrollRefTop} className="flex-1 min-h-0 overflow-y-auto pr-2 scrollbar-thin">
              {(() => {
                const base = originalBase;
                const live = originalLive;
                const combined = (base ? base + (live ? '\n\n' : '') : '') + live;
                if (!combined) {
                  return isRecording ? (
                    <div className="text-slate-400 italic text-xl md:text-2xl flex items-center gap-3">
                      <span className="inline-block w-3 h-3 bg-red-500 rounded-full animate-ping"></span>
                      正在聆听，请开始说话…
                    </div>
                  ) : (
                    <div className="text-slate-500 italic text-xl md:text-2xl">
                      点击下方麦克风按钮开始实时同传。
                    </div>
                  );
                }
                return (
                  <p
                    className="font-light leading-relaxed text-slate-100 whitespace-pre-wrap break-words"
                    style={{ fontSize: `${settings.fontSize}px`, lineHeight: 1.4 }}
                  >
                    <span className="text-slate-400">{base}</span>
                    {base && live ? '\n\n' : null}
                    <span className="text-slate-100">{live}</span>
                    {isRecording && live && (
                      <span className="inline-block w-2 h-6 ml-1 bg-blue-500 animate-pulse align-middle" style={{ height: `${settings.fontSize * 0.7}px` }}></span>
                    )}
                  </p>
                );
              })()}
            </div>
          </div>

          </section>

        {/* Bottom Half: Translated Text — accumulating turns */}
        <section className="flex-1 bg-slate-950 p-6 md:p-10 relative flex flex-col min-h-0">
          <div className="max-w-4xl w-full mx-auto flex-1 flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-4 shrink-0">
              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`}></span>
                <span className="text-xs font-bold tracking-wider text-slate-400">
                  实时翻译流 ({targetLang})
                </span>
              </div>

              {/* Speak Latest Translated Text */}
              {(translatedBase || translatedLive) && (
                <button
                  onClick={handleSpeakTranslatedText}
                  className={`flex items-center gap-2 sm:px-3.5 p-2 sm:py-1.5 rounded-full text-xs font-semibold transition-all shadow-md ${
                    isSpeaking
                      ? 'bg-emerald-600 text-white animate-pulse'
                      : 'bg-emerald-950/90 text-emerald-300 hover:bg-emerald-900 border border-emerald-800'
                  }`}
                  title="朗读最新一段翻译"
                >
                  {isSpeaking ? (
                    <>
                      <VolumeX className="w-4 h-4" />
                      <span className="hidden sm:inline">停止朗读</span>
                    </>
                  ) : (
                    <>
                      <Volume2 className="w-4 h-4 text-emerald-400" />
                      <span className="hidden sm:inline">朗读翻译</span>
                    </>
                  )}
                </button>
              )}
            </div>

            <div ref={scrollRefBottom} className="flex-1 min-h-0 overflow-y-auto pr-2 scrollbar-thin">
              {(() => {
                const base = translatedBase;
                const live = translatedLive;
                const combined = (base ? base + (live ? '\n\n' : '') : '') + live;
                if (!combined) {
                  return isRecording ? (
                    <div className="text-slate-500 italic text-xl md:text-2xl flex items-center gap-3">
                      <span className="inline-block w-2 h-2 bg-emerald-500 rounded-full animate-ping"></span>
                      翻译将实时显示在这里…
                    </div>
                  ) : (
                    <div className="text-slate-500 italic text-xl md:text-2xl">
                      点击下方麦克风按钮开始实时同传。
                    </div>
                  );
                }
                return (
                  <p
                    className="font-semibold leading-relaxed whitespace-pre-wrap break-words"
                    style={{ fontSize: `${settings.fontSize}px`, lineHeight: 1.4 }}
                  >
                    <span className="bg-gradient-to-r from-slate-500 via-slate-400 to-slate-500 bg-clip-text text-transparent">{base}</span>
                    {base && live ? '\n\n' : null}
                    <span className="bg-gradient-to-r from-blue-400 via-indigo-300 to-purple-400 bg-clip-text text-transparent">{live}</span>
                    {isRecording && live && (
                      <span className="inline-block w-2 h-6 ml-1 bg-indigo-400 animate-pulse align-middle" style={{ height: `${settings.fontSize * 0.7}px` }}></span>
                    )}
                  </p>
                );
              })()}
            </div>
          </div>
        </section>
      </main>

      {/* Control Bar */}
      <footer className="py-2.5 px-4 sm:px-6 bg-slate-900 border-t border-slate-800 flex items-center justify-center shrink-0 relative">
        <div className="flex items-center gap-3 max-w-4xl w-full justify-between sm:justify-center">
          {/* Center Mic Button + Audio Visualizer + Token counter + Action Buttons */}
          <div className="flex items-center gap-3 sm:gap-4 flex-wrap sm:flex-nowrap">
            <button
              onClick={toggleRecording}
              disabled={isConnecting}
              className={`w-14 h-14 sm:w-16 sm:h-16 rounded-full shrink-0 ${
                isRecording
                  ? 'bg-red-600 hover:bg-red-500 shadow-[0_0_35px_rgba(220,38,38,0.5)]'
                  : 'bg-blue-600 hover:bg-blue-500 shadow-[0_0_35px_rgba(37,99,235,0.5)]'
              } flex items-center justify-center border-4 border-slate-950 transition-all active:scale-95 disabled:opacity-50 z-10`}
              title={isRecording ? '点击停止录音' : '点击开始实时语音翻译'}
            >
              {isConnecting ? (
                <Loader2 className="w-6 h-6 text-white animate-spin" />
              ) : isRecording ? (
                <Square className="w-5 h-5 text-white fill-current" />
              ) : (
                <Mic className="w-6 h-6 text-white" />
              )}
            </button>

            <div className="flex flex-col items-start gap-1.5 min-w-0">
              {/* Top Row: Mic status badge + 3 Action buttons */}
              <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
                <div
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-full border backdrop-blur transition-colors shrink-0 ${
                    isRecording
                      ? 'bg-slate-950/80 border-slate-800'
                      : 'bg-red-950/40 border-red-900/60'
                  }`}
                >
                  {isRecording ? (
                    <>
                      <span className="text-[11px] text-blue-400 font-medium whitespace-nowrap">麦克风已激活</span>
                      <div className="flex items-end gap-1 h-4">
                        <div ref={el => volumeBarsRef.current[0] = el} className="w-1 bg-blue-500 rounded-full h-2 transition-all duration-75"></div>
                        <div ref={el => volumeBarsRef.current[1] = el} className="w-1 bg-blue-400 rounded-full h-3 transition-all duration-75"></div>
                        <div ref={el => volumeBarsRef.current[2] = el} className="w-1 bg-blue-300 rounded-full h-4 transition-all duration-75"></div>
                        <div ref={el => volumeBarsRef.current[3] = el} className="w-1 bg-blue-400 rounded-full h-2 transition-all duration-75"></div>
                        <div ref={el => volumeBarsRef.current[4] = el} className="w-1 bg-blue-500 rounded-full h-3 transition-all duration-75"></div>
                      </div>
                    </>
                  ) : (
                    <>
                      <span className="text-[11px] text-red-400 font-medium whitespace-nowrap">麦克风已关闭</span>
                      <div className="flex items-center h-4">
                        <div className="w-6 h-0.5 bg-red-500 rounded-full"></div>
                      </div>
                    </>
                  )}
                </div>

                {/* 3 Action Buttons beside Mic Status */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      const next = !autoPlayAudio;
                      setAutoPlayAudio(next);
                      translationPlayerRef.current?.setMuted(!next);
                    }}
                    title="切换翻译语音自动播放"
                    className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                      autoPlayAudio
                        ? 'text-indigo-300 bg-indigo-950/60 hover:bg-indigo-900/70 border-indigo-800/80'
                        : 'text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 border-slate-700'
                    }`}
                  >
                    {autoPlayAudio ? (
                      <Volume2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                    ) : (
                      <VolumeX className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <span className="hidden md:inline whitespace-nowrap">
                      翻译语音自动播 · {autoPlayAudio ? '开' : '关'}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={handleSaveTranscript}
                    className="flex items-center gap-1.5 text-xs text-emerald-300 hover:text-white bg-emerald-950/60 hover:bg-emerald-800 px-2.5 py-1.5 rounded-lg border border-emerald-800 transition-colors whitespace-nowrap shrink-0"
                    title="把当前累积的原文与译文保存为本地 .txt 文件"
                  >
                    <Download className="w-3.5 h-3.5 shrink-0" />
                    <span className="hidden md:inline whitespace-nowrap">保存</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setOriginalBase('');
                      setTranslatedBase('');
                      setOriginalLive('');
                      setTranslatedLive('');
                      pendingOrigRef.current = '';
                      pendingTransRef.current = '';
                      if (segmentCommitTimer.current) {
                        clearTimeout(segmentCommitTimer.current);
                        segmentCommitTimer.current = null;
                      }
                      if (isSpeaking) window.speechSynthesis.cancel();
                      setIsSpeaking(false);
                    }}
                    className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 rounded-lg border border-slate-700 transition-colors whitespace-nowrap shrink-0"
                    title="清空已显示的转写/翻译"
                  >
                    <RefreshCw className="w-3.5 h-3.5 shrink-0" />
                    <span className="hidden md:inline whitespace-nowrap">清空</span>
                  </button>
                </div>
              </div>

              {/* Bottom Row: Token 计数 */}
              {(isRecording || isConnecting || tokenUsage.input > 0 || tokenUsage.output > 0) && (
                <div
                  className={`flex items-center gap-2 px-3 py-1 rounded-full border text-[11px] font-mono shadow-sm backdrop-blur transition-colors whitespace-nowrap shrink-0 ${
                    isRecording || isConnecting
                      ? 'bg-slate-950/90 border-slate-700 text-slate-300'
                      : 'bg-slate-900 border-slate-800 text-slate-500'
                  }`}
                  title="本次会话累计消耗的 token(来自服务端 usageMetadata)"
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
          </div>
        </div>
      </footer>
    </div>
  );
}