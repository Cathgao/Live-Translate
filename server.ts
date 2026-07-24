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
        `[live] upstream closed code=${code} reason=${reasonStr} model=${modelName} (had setup=${isLiveReady}, upstream msgs=${totalUpstreamMessages}, client audio bytes forwarded=${totalClientAudioBytes})`,
      );
      isLiveReady = false;
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
    });

    clientWs.on("close", () => {
      clientAlive = false;
      clearTimeout(setupTimer);
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

  const HOST = process.env.HOST || "0.0.0.0";
  server.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
    console.log(
      `Live Translate model: models/${LIVE_TRANSLATE_MODEL} (override via GEMINI_LIVE_TRANSLATE_MODEL)`,
    );
  });
}

startServer();