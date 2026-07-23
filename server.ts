import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import http from "http";

dotenv.config();

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// Default per official Live Translate docs (zh-cn): gemini-3.5-live-translate-preview.
// Allow override via env if the user's API key doesn't list that exact model.
const DEFAULT_LIVE_TRANSLATE_MODEL = "gemini-3.5-live-translate-preview";
const LIVE_TRANSLATE_MODEL = (
  process.env.GEMINI_LIVE_TRANSLATE_MODEL || DEFAULT_LIVE_TRANSLATE_MODEL
).replace(/^models\//, "");

// Gemini Live WSS endpoint — stable across Live / Live Translate.
const GEMINI_LIVE_WSS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// Friendly name -> BCP-47. Matches the dropdown values used in App.tsx.
function getTargetLanguageCode(targetLang: string): string {
  const map: Record<string, string> = {
    "Chinese (Simplified)": "zh",
    "Chinese (Traditional)": "zh-TW",
    English: "en",
    Japanese: "ja",
    Korean: "ko",
    Spanish: "es",
    French: "fr",
    German: "de",
    Russian: "ru",
    Polish: "pl",
    Italian: "it",
    Portuguese: "pt",
    Arabic: "ar",
    Hindi: "hi",
    Vietnamese: "vi",
    Thai: "th",
  };
  return map[targetLang] || "zh";
}

function buildSetupMessage(modelName: string, targetLangCode: string, silenceMs: number) {
  // 参考官方 Live Translate 指南:
  //   https://ai.google.dev/gemini-api/docs/live-api/live-translate
  // 以及官方参考实现 gemini-live-translate-livekit (translation-bridge.ts
  // 第 423-444 行的 sendGeminiSetup)。
  //
  // 关键点(都已被服务端 1007 错误实证过):
  //   1. WebSocket 的线协议字段统一用 camelCase。`echoTargetLanguage` 不能写成
  //      `echo_target_language`(之前的代码就写错了)。
  //   2. `inputAudioTranscription` / `outputAudioTranscription` 是 `setup` 的
  //      直接子字段,不能放进 `generationConfig`。后者只接 `responseModalities`
  //      和 `translationConfig`(以及 speechConfig 等)。把这俩塞进
  //      generationConfig 服务端会返回 "Unknown name inputAudioTranscription
  //      at 'setup.generation_config' / 1007 Invalid JSON payload"。
  //   3. `realtimeInputConfig.automaticActivityDetection` 是官方 schema
  //      (https://ai.google.dev/api/live#automaticactivitydetection) 明确接受
  //      的对象,所有 5 个子字段 (disabled / startOfSpeechSensitivity /
  //      prefixPaddingMs / endOfSpeechSensitivity / silenceDurationMs) 都是合法
  //      的可选字段。这里把 silenceDurationMs 由调用方传入,让用户在 UI 端调。
  //   4. translationConfig.echoTargetLanguage=true 让模型对源语言已是目标语言的
  //      输入也发声(parrot),和官方示例保持一致。
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
    const sourceLang = url.searchParams.get("source") || "Auto";
    const targetLang = url.searchParams.get("target") || "Chinese (Simplified)";
    const requestedModel = url.searchParams.get("model") || "";
    const modelName = requestedModel
      ? requestedModel.replace(/^models\//, "")
      : LIVE_TRANSLATE_MODEL;
    const targetLangCode = getTargetLanguageCode(targetLang);
    // 客户端 UI 设置项:服务端 VAD 静默阈值。空 / 非法值回退 600。
    const silenceMs = (() => {
      const raw = url.searchParams.get("silenceMs");
      const n = raw == null ? NaN : parseInt(raw, 10);
      if (!Number.isFinite(n)) return 600;
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
    // 本次会话累计 token 消耗。Gemini Live 用 usageMetadata 周期性下发
    // 每个 period 的 prompt/response token 数,语义在文档里没明确(是
    // delta 还是累计),所以我们直接累加 delta,无论哪种语义都能正确反映
    // "本次会话消耗"。
    const sessionUsage = { input: 0, output: 0 };
    // Keep-alive: 在客户端还没开始发送真实音频之前,周期性向 Gemini Live
    // 发静音帧防止会话被关闭。客户端一旦发出第一段真音频就停掉。
    let keepAliveTimer: NodeJS.Timeout | null = null;
    let sawRealAudio = false;
    const KEEPALIVE_MS = 250;
    // 250 ms of Int16LE mono silence at 16 kHz = 4000 frames = 8000 bytes.
    const SILENCE_RAW = Buffer.alloc(8000, 0);
    const SILENCE_B64 = SILENCE_RAW.toString("base64");

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
    liveWs = new WebSocket(liveUrl);

    function startKeepAlive() {
      if (keepAliveTimer) return;
      console.log(`[keepalive] start, every ${KEEPALIVE_MS}ms`);
      keepAliveTimer = setInterval(() => {
        if (!liveWs || liveWs.readyState !== WebSocket.OPEN || !isLiveReady) return;
        if (sawRealAudio) return; // real audio drives the model now
        try {
          liveWs.send(
            JSON.stringify({
              realtimeInput: { audio: { data: SILENCE_B64, mimeType: "audio/pcm;rate=16000" } },
            }),
          );
        } catch (e: any) {
          console.error("[keepalive] send failed", e?.message || e);
        }
      }, KEEPALIVE_MS);
    }

    function stopKeepAlive() {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
        console.log(`[keepalive] stop`);
      }
    }

    const setupTimer = setTimeout(() => {
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

    liveWs.on("open", () => {
      console.log(`[live] upstream open, sending setup for ${modelName}`);
      const setup = buildSetupMessage(modelName, targetLangCode, silenceMs);
      try {
        liveWs?.send(JSON.stringify(setup));
      } catch (e: any) {
        console.error("[live] failed to send setup", e);
        if (clientAlive) {
          safeSend(clientWs, {
            error: `向 Gemini Live 发送 setup 失败: ${e?.message || String(e)}`,
          });
        }
      }
    });

    liveWs.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e: any) {
        console.error("[live] upstream message parse error", e);
        return;
      }
      totalUpstreamMessages++;

      // 1) setupComplete — 会话就绪。
      if (msg.setupComplete) {
        isLiveReady = true;
        clearTimeout(setupTimer);
        console.log(`[live] setupComplete for model=${modelName}`);
        startKeepAlive();
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

      // 3) serverContent: 这是 Live Translate 模型唯一会发的内容容器。
      //    参考官方 LiveKit 实现 (translation-bridge.ts handleGeminiMessage)
      //    和官方 Live Translate 文档 —— input/output transcription 和
      //    turnComplete 一定在 serverContent 下面。
      const sc = msg.serverContent;
      if (!sc) return;

      // 3a) 增量转写文本。把每帧原文/译文原样转发,客户端按顺序拼接即可。
      //     每个 chunk 上的 `finished` 标志是该 chunk 是否是当前 utterance
      //     的最后一帧(不等同于 turnComplete,只是该侧转写自然结束)。
      const it = sc.inputTranscription;
      const ot = sc.outputTranscription;
      const hasTextChunk =
        (typeof it?.text === "string" && it.text.length > 0) ||
        (typeof ot?.text === "string" && ot.text.length > 0);
      const chunkFinished =
        !!(it?.finished || ot?.finished || sc.turnComplete);

      if (hasTextChunk && clientAlive) {
        safeSend(clientWs, {
          type: "transcription",
          originalText: it?.text || "",
          translatedText: ot?.text || "",
          finished: chunkFinished,
        });
      }

      // 3b) 真正的"一句结束"信号 —— 仅在 turnComplete 时发独立事件,
      //     客户端立即把 pending buffer 落到 base。
      if (sc.turnComplete && clientAlive) {
        safeSend(clientWs, { type: "transcription_finished" });
      }

      // 3c) 模型被打断 —— 让客户端也清掉 in-progress live。
      if (sc.interrupted && clientAlive) {
        safeSend(clientWs, { type: "transcription_interrupted" });
      }

      // 4) Token 用量统计。Gemini Live 周期性下发 usageMetadata,字段是
      //    promptTokenCount / responseTokenCount / totalTokenCount(也可能有
      //    thoughtsTokenCount)。我们只统计 prompt + response,忽略思考 token。
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

      // 5) 模型生成的翻译音频 —— 透传。
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

    liveWs.on("error", (err: any) => {
      const text = err?.message || String(err);
      console.error(`[live] upstream WS error: ${text}`);
      if (clientAlive) {
        safeSend(clientWs, { error: `Gemini Live 连接错误: ${text}` });
      }
    });

    liveWs.on("close", (code, reason) => {
      const reasonStr = reason?.toString?.() || String(reason || "");
      const hadActivity = totalUpstreamMessages > 0 || totalClientAudioBytes > 0;
      console.warn(
        `[live] upstream closed code=${code} reason=${reasonStr} model=${modelName} (had setup=${isLiveReady}, upstream msgs=${totalUpstreamMessages}, client audio bytes forwarded=${totalClientAudioBytes}, sawRealAudio=${sawRealAudio})`,
      );
      isLiveReady = false;
      stopKeepAlive();
      // Surface unexpected closes; code 1000 right after setupComplete with
      // no upstream traffic is a useful diagnostic too.
      if (clientAlive && (code !== 1000 || (code === 1000 && !hadActivity))) {
        safeSend(clientWs, {
          error: `Gemini Live 关闭连接 (code=${code}${reasonStr ? `, reason=${reasonStr}` : ""}${!hadActivity ? ", 上下行未发生任何交互" : ""})`,
        });
      }
    });

    // --- Downstream: client -> us -> Gemini ---

    clientWs.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e: any) {
        console.error("[client] message parse error", e?.message || e);
        return;
      }

      if (typeof msg.audioBlob === "string" && msg.audioBlob.length > 0) {
        totalClientAudioBytes += Math.floor((msg.audioBlob.length * 3) / 4);
        sawRealAudio = true;
        stopKeepAlive();
        if (!liveWs || liveWs.readyState !== WebSocket.OPEN || !isLiveReady) {
          // Drop silently;客户端会看到没回应是因为上游没收到音频。
          // 录音中避免刷错误提示。
          return;
        }
        // 客户端 worklet 已经按 ~100 ms 一帧切好 PCM,这里直接透传。
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
        // No-op; Gemini Live is continuous-stream, not turn-based.
        return;
      }
    });

    clientWs.on("close", () => {
      clientAlive = false;
      clearTimeout(setupTimer);
      stopKeepAlive();
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
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(
      `Live Translate model: models/${LIVE_TRANSLATE_MODEL} (override via GEMINI_LIVE_TRANSLATE_MODEL)`,
    );
  });
}

startServer();