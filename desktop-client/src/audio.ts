// Microphone audio recorder + PCM stream emitter for Live Translate.
//
// Mirrors the AudioRecorderManager / TranslationAudioPlayer classes from the
// web frontend (frontend/src/App.tsx), adapted into plain TypeScript modules
// (no React). Kept as close to the original as possible — including the
// "dummy gain node" trick and the AudioContext watchdog — because these are
// load-bearing patterns for long-running microphone capture.

export const PCM_MIME_TYPE = "audio/pcm;rate=16000";
export const CHUNK_SAMPLES = 1600; // 100 ms @ 16 kHz
const WORKLET_URL = new URL("/pcm-worklet.js", import.meta.url).href;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize)) as any,
    );
  }
  return btoa(binary);
}

export class AudioRecorderManager {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private dummyGainNode: GainNode | null = null;
  private sampleAcc: Int16Array = new Int16Array(0);

  private onChunkCallback: ((base64: string, mimeType: string) => void) | null = null;
  private onVolumeCallback: ((vol: number) => void) | null = null;
  private lastLogTime = 0;
  private watchdogTimer: number | null = null;
  private lastWorkletMsgTime = Date.now();

  async start(
    onChunkAvailable: (base64: string, mimeType: string) => void,
    onVolume?: (vol: number) => void,
  ) {
    this.onChunkCallback = onChunkAvailable;
    this.onVolumeCallback = onVolume ?? null;
    this.sampleAcc = new Int16Array(0);
    this.lastWorkletMsgTime = Date.now();

    console.log("[mic] requesting getUserMedia...");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    const audioTrack = this.stream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.onmute = () => console.warn("[mic track] muted");
      audioTrack.onunmute = () => {
        console.log("[mic track] unmuted");
        this.resumeIfSuspended();
      };
      audioTrack.onended = () => console.warn("[mic track] ended");
    }

    const AudioCtx =
      window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioCtx({ sampleRate: 16000 });

    this.audioContext.onstatechange = () => {
      console.log("[mic] state:", this.audioContext?.state);
      this.resumeIfSuspended();
    };

    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    await this.audioContext.audioWorklet.addModule(WORKLET_URL);

    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.workletNode = new AudioWorkletNode(this.audioContext, "pcm-sender-processor");

    this.workletNode.onprocessorerror = (ev) =>
      console.error("[mic worklet] error:", ev);

    this.workletNode.port.onmessage = (ev: MessageEvent) => {
      this.lastWorkletMsgTime = Date.now();
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === "pcm") {
        this.handlePcm(new Int16Array(msg.buffer));
      } else if (msg.type === "volume") {
        if (this.onVolumeCallback) this.onVolumeCallback(msg.value);
      }
    };

    this.sourceNode.connect(this.workletNode);

    // CRITICAL: connect worklet to destination via a zero-gain node. Without
    // this the browser optimizes the audio graph away and suspends after a
    // long silence.
    this.dummyGainNode = this.audioContext.createGain();
    this.dummyGainNode.gain.value = 0;
    this.workletNode.connect(this.dummyGainNode);
    this.dummyGainNode.connect(this.audioContext.destination);

    this.startWatchdog();
    console.log("[mic] started — worklet active");
  }

  public async resumeIfSuspended() {
    if (
      this.audioContext &&
      (this.audioContext.state === "suspended" ||
        (this.audioContext as any).state === "interrupted")
    ) {
      try {
        await this.audioContext.resume();
      } catch (e) {
        console.warn("[mic] resume failed:", e);
      }
    }
  }

  private startWatchdog() {
    this.stopWatchdog();
    this.watchdogTimer = window.setInterval(async () => {
      if (!this.audioContext) return;
      if (
        this.audioContext.state === "suspended" ||
        (this.audioContext as any).state === "interrupted"
      ) {
        console.warn(`[mic watchdog] state=${this.audioContext.state}, resume...`);
        await this.resumeIfSuspended();
      }
      const silenceDuration = Date.now() - this.lastWorkletMsgTime;
      if (silenceDuration > 2500) {
        console.warn(`[mic watchdog] stalled ${silenceDuration}ms, re-kicking...`);
        try {
          if (this.audioContext.state === "running") {
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
        view.setInt16(i * 2, slice[i], true);
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
        console.log(`[worklet] emitted ${emitted} chunk(s)`);
        this.lastLogTime = now;
      }
    }
  }

  stop() {
    this.stopWatchdog();
    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ type: "stop" });
      } catch (_) {}
      try {
        this.workletNode.disconnect();
      } catch (_) {}
    }
    if (this.dummyGainNode) {
      try {
        this.dummyGainNode.disconnect();
      } catch (_) {}
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch (_) {}
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

export class TranslationAudioPlayer {
  private audioContext: AudioContext | null = null;
  private nextStartTime = 0;
  private muted = false;

  setMuted(m: boolean) {
    this.muted = m;
  }

  private ensureContext(): AudioContext {
    if (!this.audioContext) {
      const AudioCtx =
        window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioCtx({ sampleRate: 24000 });
    }
    return this.audioContext;
  }

  enqueue(base64Pcm: string) {
    if (this.muted) return;
    if (!base64Pcm) return;
    try {
      const ctx = this.ensureContext();
      if (ctx.state === "suspended") ctx.resume().catch(() => {});

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
      console.error("[translation audio] enqueue failed", e);
    }
  }

  stop() {
    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch (_) {}
    }
    this.audioContext = null;
    this.nextStartTime = 0;
  }
}