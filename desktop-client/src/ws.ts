// WebSocket dispatch for the /live endpoint.
//
// The server URL is supplied at runtime by the caller (App.tsx reads it from
// the user's settings, which are persisted to a JSON file in the OS app-data
// directory — see src/configStore.ts and src-tauri/src/config.rs). The same
// JSON protocol that the browser frontend uses (see frontend/src/App.tsx:537-727).
// A simplified version without auto-reconnect, settings, or wake-lock — the
// desktop client is single-window, so we keep the connection lifecycle simple.

export type ServerMsg =
  | { type: "connection_established" }
  | { type: "ping" }
  | {
      type: "transcription";
      originalText?: string;
      translatedText?: string;
      finished?: boolean;
    }
  | { type: "transcription_finished" }
  | { type: "transcription_interrupted" }
  | {
      type: "translation_audio";
      audio?: string;
      mimeType?: string;
    }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "error"; message?: string; error?: string };

export interface LiveCallbacks {
  onConnectionEstablished: () => void;
  onTranscription: (msg: {
    originalText: string;
    translatedText: string;
    finished?: boolean;
  }) => void;
  onTranscriptionFinished: () => void;
  onTranscriptionInterrupted: () => void;
  onTranslationAudio: (audio: string, mimeType?: string) => void;
  onUsage: (input: number, output: number) => void;
  onError: (msg: string) => void;
  onPing: () => void;
  onClose: (code: number, reason: string) => void;
  onOpen: () => void;
}

export interface LiveOptions {
  wsUrl: string;
  source: string; // "Auto" or specific
  target: string;
  silenceMs: number;
  token?: string;
}

export class LiveClient {
  private ws: WebSocket | null = null;
  private cb: LiveCallbacks;
  private opts: LiveOptions;
  public manuallyClosed = false;

  constructor(opts: LiveOptions, cb: LiveCallbacks) {
    this.opts = opts;
    this.cb = cb;
  }

  connect() {
    this.manuallyClosed = false;
    const baseUrl = this.opts.wsUrl.replace(/\/+$/, "");
    if (!baseUrl) {
      this.cb.onError("WebSocket 地址未配置，请在设置里填写。");
      return;
    }
    const params = new URLSearchParams({
      source: this.opts.source,
      target: this.opts.target,
      silenceMs: String(this.opts.silenceMs),
    });
    if (this.opts.token) params.set("token", this.opts.token);
    const url = `${baseUrl}?${params.toString()}`;
    console.log(`[ws] connecting to ${url}`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      console.log("[ws] connected");
      this.cb.onOpen();
    };

    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        console.error("[ws] parse error:", err);
        return;
      }

      switch (msg.type) {
        case "connection_established":
          this.cb.onConnectionEstablished();
          break;
        case "ping":
          // Reply with pong to keep the heartbeat alive.
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "pong" }));
          }
          this.cb.onPing();
          break;
        case "transcription":
          this.cb.onTranscription({
            originalText: msg.originalText || "",
            translatedText: msg.translatedText || "",
            finished: msg.finished,
          });
          break;
        case "transcription_finished":
          this.cb.onTranscriptionFinished();
          break;
        case "transcription_interrupted":
          this.cb.onTranscriptionInterrupted();
          break;
        case "translation_audio":
          if (msg.audio) {
            this.cb.onTranslationAudio(msg.audio, msg.mimeType);
          }
          break;
        case "usage":
          this.cb.onUsage(msg.inputTokens || 0, msg.outputTokens || 0);
          break;
        case "error":
          this.cb.onError(msg.message || msg.error || "(no message)");
          break;
      }
    };

    ws.onerror = (ev) => {
      console.warn("[ws error event]", ev);
    };

    ws.onclose = (ev) => {
      console.log(`[ws] closed code=${ev.code} reason=${ev.reason}`);
      this.cb.onClose(ev.code, ev.reason || "");
    };
  }

  sendAudioChunk(base64: string, mimeType: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ audioBlob: base64, mimeType }));
    }
  }

  sendFlush() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: "flush" }));
    }
  }

  close() {
    this.manuallyClosed = true;
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ action: "flush" }));
        }
      } catch (_) {}
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
  }
}