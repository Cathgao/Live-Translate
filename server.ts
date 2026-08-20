import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import http from "http";

dotenv.config();

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// Optional token check for /live WebSocket connections.
// When CLIENT_AUTH_TOKEN is set in .env, external clients (non-browser) must
// include it as a `token` query string parameter when connecting to /live.
// Web browsers do not need to provide it and will pass through unchanged.
// Leave CLIENT_AUTH_TOKEN empty to disable authentication entirely.
const CLIENT_AUTH_TOKEN = process.env.CLIENT_AUTH_TOKEN || "";
const clientAuthEnabled = CLIENT_AUTH_TOKEN.length > 0;

// Default per official Live Translate docs (zh-cn): gemini-3.5-live-translate-preview.
// Allow override via env if the user's API key doesn't list that exact model.
const DEFAULT_LIVE_TRANSLATE_MODEL = "gemini-3.5-live-translate-preview";
const LIVE_TRANSLATE_MODEL = (
  process.env.GEMINI_LIVE_TRANSLATE_MODEL || DEFAULT_LIVE_TRANSLATE_MODEL
).replace(/^models\//, "");

// Gemini Live WSS endpoint — stable across Live / Live Translate.
const GEMINI_LIVE_WSS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// Friendly name / language code -> BCP-47. Matches the dropdown values used in App.tsx & common language codes.
function getTargetLanguageCode(targetLang: string): string {
  if (!targetLang || typeof targetLang !== "string") return "zh";
  const trimmed = targetLang.trim();
  const lower = trimmed.toLowerCase();

  const map: Record<string, string> = {
    // English friendly names
    "chinese (simplified)": "zh",
    "chinese (traditional)": "zh-TW",
    english: "en",
    japanese: "ja",
    korean: "ko",
    spanish: "es",
    french: "fr",
    german: "de",
    russian: "ru",
    polish: "pl",
    italian: "it",
    portuguese: "pt",
    arabic: "ar",
    hindi: "hi",
    vietnamese: "vi",
    thai: "th",

    // Chinese friendly names
    "中文": "zh",
    "简体中文": "zh",
    "繁体中文": "zh-TW",
    "英语": "en",
    "英文": "en",
    "日语": "ja",
    "韩语": "ko",
    "西班牙语": "es",
    "法语": "fr",
    "德语": "de",
    "俄语": "ru",
    "波兰语": "pl",
    "意大利语": "it",
    "葡萄牙语": "pt",
    "阿拉伯语": "ar",
    "印地语": "hi",
    "越南语": "vi",
    "泰语": "th",

    // Common BCP-47 / ISO-639 codes
    zh: "zh",
    "zh-cn": "zh",
    "zh-hans": "zh",
    "zh-tw": "zh-TW",
    "zh-hant": "zh-TW",
    "zh-hk": "zh-TW",
    en: "en",
    "en-us": "en",
    "en-gb": "en",
    ja: "ja",
    "ja-jp": "ja",
    ko: "ko",
    "ko-kr": "ko",
    es: "es",
    "es-es": "es",
    fr: "fr",
    "fr-fr": "fr",
    de: "de",
    "de-de": "de",
    ru: "ru",
    "ru-ru": "ru",
    pl: "pl",
    it: "it",
    pt: "pt",
    "pt-br": "pt",
    "pt-pt": "pt",
    ar: "ar",
    hi: "hi",
    vi: "vi",
    th: "th",
  };

  if (map[lower]) {
    return map[lower];
  }

  // If it's already a standard 2-3 letter language code or BCP-47 tag (e.g. "nl", "id", "fil-PH"), use it directly
  if (/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]+)*$/.test(trimmed)) {
    return trimmed;
  }

  return "zh";
}

function buildSetupMessage(
  modelName: string,
  targetLangCode: string,
  silenceMs: number,
  resumeHandle: string | null,
) {
  // Per https://ai.google.dev/gemini-api/docs/live-api/session-management the
  // server emits `GoAway` before the BidiGenerateContent connection's hard
  // ~10min lifetime expires. We enable `sessionResumption` so the server
  // periodically sends a `SessionResumptionUpdate.newHandle` that we can hand
  // to the next connection to keep the same logical session alive.
  return {
    setup: {
      model: `models/${modelName}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: {
          targetLanguageCode: targetLangCode,
          echoTargetLanguage: true,
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          silenceDurationMs: silenceMs,
        },
      },
      sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
    },
  };
}

function safeClose(clientWs: WebSocket | null) {
  if (clientWs && clientWs.readyState === WebSocket.OPEN) {
    try { clientWs.close(); } catch (_) {}
  }
}

function safeSend(ws: WebSocket | null, payload: unknown): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (e) {
    console.error("[client send failed]", e);
    return false;
  }
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);

  const wss = new WebSocketServer({ server, path: "/live" });

  wss.on("connection", (clientWs: WebSocket, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);

    // Optional token check: when CLIENT_AUTH_TOKEN is set, require matching
    // `token` query parameter. Browsers don't need to send it.
    if (clientAuthEnabled) {
      const provided = url.searchParams.get("token") || "";
      if (provided !== CLIENT_AUTH_TOKEN) {
        const remote = req.socket?.remoteAddress || "?";
        console.warn(`[live] rejected connection from ${remote}: bad or missing token`);
        try {
          safeSend(clientWs, { error: "Unauthorized: invalid or missing token" });
        } catch (_) {}
        try {
          clientWs.close(1008, "unauthorized");
        } catch (_) {}
        return;
      }
      console.log(`[live] token check passed for ${req.socket?.remoteAddress || "?"}`);
    }

    const sourceLang =
      url.searchParams.get("source") ||
      url.searchParams.get("source_lang") ||
      url.searchParams.get("sourceLang") ||
      url.searchParams.get("from") ||
      "Auto";
    const targetLang =
      url.searchParams.get("target") ||
      url.searchParams.get("target_lang") ||
      url.searchParams.get("targetLang") ||
      url.searchParams.get("to") ||
      "Chinese (Simplified)";
    const requestedModel = url.searchParams.get("model") || "";
    const modelName = requestedModel
      ? requestedModel.replace(/^models\//, "")
      : LIVE_TRANSLATE_MODEL;
    const targetLangCode = getTargetLanguageCode(targetLang);
    const silenceMs = (() => {
      const raw = url.searchParams.get("silenceMs");
      const n = raw == null ? NaN : parseInt(raw, 10);
      if (!Number.isFinite(n)) return 1000;
      return Math.min(2000, Math.max(100, n));
    })();

    console.log(
      `[live] client connected. source=${sourceLang} target=${targetLang} (${targetLangCode}) model=${modelName} silenceMs=${silenceMs}`,
    );

    let liveWs: WebSocket | null = null;
    let isLiveReady = false;
    let clientAlive = true;
    let totalUpstreamMessages = 0;
    let totalClientAudioBytes = 0;
    const sessionUsage = { input: 0, output: 0 };

    // Session resumption / reconnect state. Per the official Live API
    // session-management docs, each BidiGenerateContent connection has a hard
    // ~10min lifetime and the server emits `GoAway` before tearing it down.
    // We persist the latest `SessionResumptionUpdate.newHandle` so the next
    // upstream WS can be opened with `sessionResumption: { handle }` and
    // continue the same logical session.
    let currentResumeHandle: string | null = null;
    let currentHandleResumable = true;
    let upstreamReconnectAttempts = 0;
    let upstreamReconnectTimer: NodeJS.Timeout | null = null;
    const MAX_UPSTREAM_RECONNECTS = 5;
    // Tiny headroom before Gemini's declared `timeLeft` to make sure we
    // can finish the new upstream handshake before the old one closes.
    const GOAWAY_RECONNECT_HEADROOM_MS = 5000;
    // When GoAway arrives we don't immediately reconnect — we wait for the
    // current spoken segment to finish so the rotated upstream doesn't chop
    // a sentence in half. The deadline is (timeLeft - headroom); whichever
    // comes first wins: a `transcription_finished` / `turnComplete` /
    // `inputTranscription.finished` / `outputTranscription.finished` signal,
    // or the deadline.
    let goAwaySegmentDeadline: number | null = null;
    let goAwayReconnectPending = false;

    // Periodic ping/pong heartbeat to keep client <-> server and server <-> Gemini connections active during long silences
    const pingInterval = setInterval(() => {
      if (clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.ping();
          safeSend(clientWs, { type: "ping" });
        } catch (_) {}
      }
      if (liveWs && liveWs.readyState === WebSocket.OPEN && isLiveReady) {
        try {
          liveWs.ping();
        } catch (_) {}
      }
    }, 15000);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      safeSend(clientWs, {
        error:
          "Server is missing GEMINI_API_KEY. Set it in .env before starting the server.",
      });
      try {
        clientWs.close();
      } catch (_) {}
      return;
    }

    const liveUrl = `${GEMINI_LIVE_WSS}?key=${encodeURIComponent(apiKey)}`;

    let setupTimer: NodeJS.Timeout | null = null;
    const armSetupTimer = () => {
      if (setupTimer) clearTimeout(setupTimer);
      setupTimer = setTimeout(() => {
        if (!isLiveReady && liveWs && liveWs.readyState !== WebSocket.CLOSED) {
          console.error(
            `[live] setupComplete not received within 15s for model=${modelName}`,
          );
          if (clientAlive) {
            safeSend(clientWs, {
              error: `Live Translate 模型 [${modelName}] 15s 内未返回 setupComplete，请检查 API key 是否对该模型拥有访问权限。`,
            });
          }
          try {
            liveWs.close();
          } catch (_) {}
        }
      }, 15000);
    };

    const openUpstream = () => {
      const prev = liveWs;
      const ws = new WebSocket(liveUrl);
      liveWs = ws;
      isLiveReady = false;
      armSetupTimer();
      // 关闭旧 upstream（如有）。新 ws 尚未 open，旧 ws 仍可正常接收残余音频直到
      // 新 ws 走完 setup；这里的 close 是清场，关不关都不影响接管。
      if (prev && prev !== ws) {
        try {
          if (prev.readyState === WebSocket.OPEN) {
            console.log(`[live] closing previous upstream proactively`);
            prev.close(1000, "upstream rotated");
          }
        } catch (_) {}
      }

      ws.on("open", () => {
        console.log(
          `[live] upstream open, sending setup for ${modelName}` +
            (currentResumeHandle ? ` (resuming with handle)` : ``),
        );
        const setup = buildSetupMessage(
          modelName,
          targetLangCode,
          silenceMs,
          currentResumeHandle,
        );
        try {
          ws.send(JSON.stringify(setup));
        } catch (e: any) {
          console.error("[live] failed to send setup", e);
          if (clientAlive) {
            safeSend(clientWs, {
              error: `向 Gemini Live 发送 setup 失败: ${e?.message || String(e)}`,
            });
          }
        }
      });

      ws.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch (e: any) {
          console.error("[live] upstream message parse error", e);
          return;
        }
        totalUpstreamMessages++;

        // 0) SessionResumptionUpdate — 记录 resume handle（官方 session-management 文档）
        const sru = msg.sessionResumptionUpdate;
        if (sru && typeof sru.newHandle === "string" && sru.newHandle.length > 0) {
          const handle = sru.newHandle;
          currentResumeHandle = handle;
          currentHandleResumable = !!sru.resumable;
          // 不打日志：每 ~3s 一条太吵。但 handle 仍保留在 currentResumeHandle。
          return;
        }

        // 0b) GoAway — 上游即将终止（连接寿命 ~10 分钟）。
        // 不要立即重连：等待当前 segment 自然结束（seg-finish 信号），避免在
        // 句子中间切。如果到 deadline 还没等到信号，强制重连。
        const goAway = msg.goAway;
        if (goAway) {
          const timeLeftStr = goAway.timeLeft;
          // timeLeft is a string like "50s" or "1m30s". Parse to millis.
          let timeLeftMs = 0;
          if (typeof timeLeftStr === "string") {
            const m = timeLeftStr.match(/(\d+)\s*([smh])/g);
            if (m) {
              for (const part of m) {
                const [, nStr, unit] = part.match(/(\d+)\s*([smh])/) || [];
                const n = parseInt(nStr, 10);
                if (unit === "s") timeLeftMs += n * 1000;
                else if (unit === "m") timeLeftMs += n * 60_000;
                else if (unit === "h") timeLeftMs += n * 3_600_000;
              }
            }
          }
          const deadline = Math.max(500, timeLeftMs - GOAWAY_RECONNECT_HEADROOM_MS);
          goAwaySegmentDeadline = Date.now() + deadline;
          goAwayReconnectPending = true;
          console.warn(
            `[live] upstream GoAway received timeLeft=${timeLeftStr} (${timeLeftMs}ms); awaiting next segment boundary (deadline in ${deadline}ms); handle=${currentResumeHandle ? "yes" : "no"}, handleResumable=${currentHandleResumable}`,
          );
          if (clientAlive) {
            safeSend(clientWs, { type: "upstream_goaway", timeLeft: timeLeftStr });
          }

          // 兜底：到 deadline 强制重连（即使 segment 还没结束）
          if (upstreamReconnectTimer) clearTimeout(upstreamReconnectTimer);
          upstreamReconnectTimer = setTimeout(() => {
            upstreamReconnectTimer = null;
            if (!goAwayReconnectPending) return; // 已经在段尾提前重连过了
            if (!clientAlive) return;
            console.warn(
              `[live] GoAway deadline reached without segment boundary; reconnecting upstream now`,
            );
            goAwayReconnectPending = false;
            goAwaySegmentDeadline = null;
            safeSend(clientWs, { type: "upstream_reset" });
            openUpstream();
          }, deadline);
          return;
        }

        // 1) setupComplete — 会话就绪。
        if (msg.setupComplete) {
          isLiveReady = true;
          if (setupTimer) {
            clearTimeout(setupTimer);
            setupTimer = null;
          }
          console.log(`[live] setupComplete for model=${modelName} (resumed=${currentResumeHandle ? "yes" : "no"})`);
          // 新 upstream 就绪 → 重置重连计数
          upstreamReconnectAttempts = 0;
          return;
        }

        // 2) error
        if (msg.error) {
          const errText =
            typeof msg.error === "string"
              ? msg.error
              : msg.error.message || JSON.stringify(msg.error);
          console.error(`[live] upstream error: ${errText}`);
          if (clientAlive) {
            safeSend(clientWs, {
              error: `Gemini Live 模型 [${modelName}] 错误: ${errText}`,
            });
          }
          return;
        }
        const sc = msg.serverContent;
        if (!sc) return;
        const it = sc.inputTranscription;
        const ot = sc.outputTranscription;
        const hasTextChunk =
          (typeof it?.text === "string" && it.text.length > 0) ||
          (typeof ot?.text === "string" && ot.text.length > 0);
        const chunkFinished =
          !!(it?.finished || ot?.finished || sc.turnComplete);

        if (hasTextChunk && clientAlive) {
          console.log(`[diag-upstream] text-chunk origLen=${it?.text?.length || 0} transLen=${ot?.text?.length || 0} finished=${chunkFinished} turnComplete=${!!sc.turnComplete}`);
          safeSend(clientWs, {
            type: "transcription",
            originalText: it?.text || "",
            translatedText: ot?.text || "",
            finished: chunkFinished,
          });
        }
        if (sc.turnComplete && clientAlive) {
          safeSend(clientWs, { type: "transcription_finished" });
        }
        if (sc.interrupted && clientAlive) {
          safeSend(clientWs, { type: "transcription_interrupted" });
        }

        // 段尾提前重连：GoAway 等待中、且当前 segment 已结束（任意一个 finished/turnComplete）。
        // 在 deadline 之前找到自然停顿点，立刻触发 upstream reopen（覆盖 deadline timer）。
        if (
          goAwayReconnectPending &&
          clientAlive &&
          (chunkFinished || sc.turnComplete)
        ) {
          const remaining = goAwaySegmentDeadline ? goAwaySegmentDeadline - Date.now() : 0;
          console.log(
            `[live] segment boundary reached during GoAway window; reconnecting upstream now (${remaining}ms before deadline)`,
          );
          goAwayReconnectPending = false;
          goAwaySegmentDeadline = null;
          if (upstreamReconnectTimer) {
            clearTimeout(upstreamReconnectTimer);
            upstreamReconnectTimer = null;
          }
          safeSend(clientWs, { type: "upstream_reset" });
          openUpstream();
        }
        const um = msg.usageMetadata;
        if (um && clientAlive) {
          const deltaIn = typeof um.promptTokenCount === "number" ? um.promptTokenCount : 0;
          const deltaOut = typeof um.responseTokenCount === "number" ? um.responseTokenCount : 0;
          sessionUsage.input += deltaIn;
          sessionUsage.output += deltaOut;
          safeSend(clientWs, {
            type: "usage",
            inputTokens: sessionUsage.input,
            outputTokens: sessionUsage.output,
          });
        }
        const parts: any[] | undefined = sc.modelTurn?.parts;
        if (Array.isArray(parts) && clientAlive) {
          for (const part of parts) {
            const inline = part?.inlineData || part?.inline_data;
            if (!inline) continue;
            const data: string | undefined = inline.data;
            if (!data) continue;
            const mime: string =
              inline.mimeType || inline.mime_type || "audio/pcm;rate=24000";
            safeSend(clientWs, {
              type: "translation_audio",
              audio: data,
              mimeType: mime,
            });
          }
        }
      });

      ws.on("error", (err: any) => {
        const text = err?.message || String(err);
        console.error(`[live] upstream WS error: ${text}`);
        // 不在这里给客户端发 error — close handler 会处理。
      });

      ws.on("close", (code, reason) => {
        const reasonStr = reason?.toString?.() || String(reason || "");
        const hadActivity = totalUpstreamMessages > 0 || totalClientAudioBytes > 0;
        // 关闭的是当前这条 liveWs；如果它已经被新连接替换，记录日志但不动
        if (liveWs !== ws) {
          console.log(
            `[live] old upstream closed code=${code} reason=${reasonStr} (already replaced by new upstream)`,
          );
          return;
        }
        console.warn(
          `[live] upstream closed code=${code} reason=${reasonStr} model=${modelName} (had setup=${isLiveReady}, upstream msgs=${totalUpstreamMessages}, client audio bytes forwarded=${totalClientAudioBytes}, resumeHandle=${currentResumeHandle ? "yes" : "no"}, reconnectAttempts=${upstreamReconnectAttempts})`,
        );
        isLiveReady = false;
        if (setupTimer) {
          clearTimeout(setupTimer);
          setupTimer = null;
        }

        // 客户端不在就退出
        if (!clientAlive) return;

        // 如果我们已经在 GoAway 之后调度了上游重连，那这次 close 是预期的，
        // 不再走错误回传；上游 rest 连接 openUpstream 自己会开。
        if (upstreamReconnectTimer) {
          console.log(`[live] upstream close after GoAway: scheduled reconnect will open new upstream`);
          return;
        }

        // 1) 异常关闭（非 1000/1008）→ 直接告诉客户端
        if (code !== 1000 && code !== 1008) {
          safeSend(clientWs, {
            error: `Gemini Live 关闭连接 (code=${code}${reasonStr ? `, reason=${reasonStr}` : ""})`,
          });
          return;
        }

        // 2) 1000/1008 关闭但没 GoAway 调度 → 兜底重连
        if (upstreamReconnectAttempts >= MAX_UPSTREAM_RECONNECTS) {
          console.error(
            `[live] upstream auto-reconnect exhausted after ${upstreamReconnectAttempts} attempts; giving up on this client`,
          );
          safeSend(clientWs, {
            error: `Gemini Live 上游自动重连 ${MAX_UPSTREAM_RECONNECTS} 次仍失败，请稍后重新开始。`,
          });
          try { clientWs.close(); } catch (_) {}
          return;
        }
        upstreamReconnectAttempts += 1;
        const delay = Math.min(500 * Math.pow(2, upstreamReconnectAttempts - 1), 5000);
        console.log(
          `[live] scheduling upstream reconnect #${upstreamReconnectAttempts}/${MAX_UPSTREAM_RECONNECTS} in ${delay}ms (fallback, no GoAway)`,
        );
        if (upstreamReconnectTimer) clearTimeout(upstreamReconnectTimer);
        upstreamReconnectTimer = setTimeout(() => {
          upstreamReconnectTimer = null;
          if (!clientAlive) return;
          safeSend(clientWs, { type: "upstream_reset" });
          openUpstream();
        }, delay);
      });
    };

    openUpstream();

    // --- Downstream: client -> us -> Gemini ---

    clientWs.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e: any) {
        console.error("[client] message parse error", e?.message || e);
        return;
      }

      if (msg.type === "ping" || msg.type === "pong") {
        if (msg.type === "ping") {
          safeSend(clientWs, { type: "pong" });
        }
        return;
      }

      if (typeof msg.audioBlob === "string" && msg.audioBlob.length > 0) {
        totalClientAudioBytes += Math.floor((msg.audioBlob.length * 3) / 4);
        if (!liveWs || liveWs.readyState !== WebSocket.OPEN || !isLiveReady) {
          return;
        }
        try {
          liveWs.send(
            JSON.stringify({
              realtimeInput: {
                audio: {
                  data: msg.audioBlob,
                  mimeType: "audio/pcm;rate=16000",
                },
              },
            }),
          );
        } catch (e: any) {
          console.error("[upstream send] realtimeInput send failed", e?.message || e);
          if (clientAlive) {
            safeSend(clientWs, {
              error: `向 Gemini Live 发送音频失败: ${e?.message || String(e)}`,
            });
          }
        }
        return;
      }

      if (msg.action === "flush") {
        return;
      }

      if (msg.action === "commit") {
        // Client says: UI just committed a paragraph (5s silence timer fired).
        // If we're in the GoAway window, rotate the upstream NOW at this
        // natural boundary so the rotated session doesn't chop a sentence.
        if (goAwayReconnectPending && clientAlive) {
          const remaining = goAwaySegmentDeadline ? goAwaySegmentDeadline - Date.now() : 0;
          console.log(
            `[live] client signalled segment commit during GoAway window; reconnecting upstream now (${remaining}ms before deadline)`,
          );
          goAwayReconnectPending = false;
          goAwaySegmentDeadline = null;
          if (upstreamReconnectTimer) {
            clearTimeout(upstreamReconnectTimer);
            upstreamReconnectTimer = null;
          }
          safeSend(clientWs, { type: "upstream_reset" });
          openUpstream();
        }
        return;
      }
    });

    clientWs.on("close", () => {
      clientAlive = false;
      if (setupTimer) {
        clearTimeout(setupTimer);
        setupTimer = null;
      }
      if (upstreamReconnectTimer) {
        clearTimeout(upstreamReconnectTimer);
        upstreamReconnectTimer = null;
      }
      goAwayReconnectPending = false;
      goAwaySegmentDeadline = null;
      clearInterval(pingInterval);
      if (liveWs && liveWs.readyState === WebSocket.OPEN) {
        try {
          liveWs.close();
        } catch (_) {}
      }
    });

    clientWs.on("error", (err: any) => {
      console.error("[client] WS error", err?.message || err);
    });

    safeSend(clientWs, { type: "connection_established" });
  });

  // Vite middleware for development; static for production.
  if (process.env.NODE_ENV !== "production") {
    // Frontend lives in ./frontend; root tells Vite where to find
    // index.html and source files. publicDir keeps /pcm-worklet.js
    // and /translation.png accessible at the URL root.
    const vite = await createViteServer({
      root: path.join(process.cwd(), "frontend"),
      publicDir: path.join(process.cwd(), "frontend", "public"),
      configFile: path.join(process.cwd(), "frontend", "vite.config.ts"),
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "frontend", "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const HOST = process.env.HOST || "0.0.0.0";
  server.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
    console.log(
      `Live Translate model: models/${LIVE_TRANSLATE_MODEL} (override via GEMINI_LIVE_TRANSLATE_MODEL)`,
    );
  });
}

startServer();