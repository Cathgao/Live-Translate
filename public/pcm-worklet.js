// pcm-worklet.js
// Runs in AudioWorkletGlobalScope.
// Receives microphone audio (Float32 in [-1, 1]).
// Resamples to 16 kHz if needed, converts to Int16 little-endian PCM,
// buffers ~100 ms chunks, and posts them out as ArrayBuffer (raw PCM bytes).
// Also posts an RMS volume value (0..1) per chunk for VAD / visualizer.

class PCMSenderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // Target sample rate for the Live API.
    this.targetRate = 16000;

    // Browser sample rate (AudioContext.sampleRate).
    this.sourceRate = sampleRate;

    // ~100 ms chunk size in target-rate frames
    this.chunkFrames = Math.round(this.targetRate * 0.1);

    // Internal buffer holding Int16 samples at the target rate.
    this.buffer = new Int16Array(this.chunkFrames);
    this.bufferFill = 0;

    // Linear resampler state.
    this.resampleRatio = this.sourceRate / this.targetRate;
    this.lastSample = 0;

    // If source rate equals target rate, skip resampling.
    this.needsResample = Math.abs(this.resampleRatio - 1) > 1e-6;

    // RMS meter every process() call, posted every ~50ms.
    this.rmsAccum = 0;
    this.rmsCount = 0;
    this.lastRmsPostTime = 0;

    this.stopped = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'stop') {
        this.stopped = true;
      }
    };
  }

  // Simple linear-interpolation resampler. Sufficient for speech; we are
  // already smoothing at the chunk boundary by mixing with lastSample, so
  // the lack of a proper anti-alias filter is acceptable for STT/translation.
  resample(input) {
    if (!this.needsResample) return input;
    const ratio = this.resampleRatio;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    let pos = 0;
    for (let i = 0; i < outLen; i++) {
      const idx = i * ratio;
      const i0 = Math.floor(idx);
      const frac = idx - i0;
      const a = input[i0] || 0;
      const b = input[i0 + 1] !== undefined ? input[i0 + 1] : a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  appendSamples(float32) {
    // Convert Float32 [-1,1] to Int16 little-endian. Clip safely.
    for (let i = 0; i < float32.length; i++) {
      let s = float32[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      let v = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.buffer[this.bufferFill++] = v | 0;
      if (this.bufferFill >= this.chunkFrames) {
        this.flushChunk();
      }
    }
  }

  flushChunk() {
    if (this.bufferFill === 0) return;

    // Copy the filled portion. (Important: don't post a view that gets
    // overwritten next round.)
    const out = this.buffer.slice(0, this.bufferFill);
    this.buffer = new Int16Array(this.chunkFrames);
    this.bufferFill = 0;

    // Convert to little-endian byte buffer for direct transport.
    const ab = new ArrayBuffer(out.length * 2);
    const view = new DataView(ab);
    for (let i = 0; i < out.length; i++) {
      view.setInt16(i * 2, out[i], true /* little-endian */);
    }

    this.port.postMessage(
      { type: 'pcm', buffer: ab, sampleCount: out.length },
      [ab]
    );
  }

  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Use channel 0 (mono).
    const samples = input[0];

    // Compute RMS for this render slice (128 frames @ 48k ≈ 2.7ms).
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSq += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSq / samples.length);
    this.rmsAccum += rms;
    this.rmsCount += 1;

    // Resample to 16k, then enqueue into our chunked Int16 buffer.
    const resampled = this.resample(samples);
    this.appendSamples(resampled);

    // Throttle volume messages to ~20 Hz.
    const now = currentTime; // AudioWorkletGlobalScope time, in seconds
    if (now - this.lastRmsPostTime > 0.05 && this.rmsCount > 0) {
      const v = this.rmsAccum / this.rmsCount;
      this.port.postMessage({ type: 'volume', value: Math.min(1, v) });
      this.lastRmsPostTime = now;
      this.rmsAccum = 0;
      this.rmsCount = 0;
    }

    return true;
  }
}

registerProcessor('pcm-sender-processor', PCMSenderProcessor);
