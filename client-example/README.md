# Live Translate — Node.js Reference Client

A console-based client that demonstrates how to talk to the same `/live`
WebSocket endpoint the Web frontend uses. It streams audio up (microphone,
file, or stdin) and prints the original + translated text to the terminal
in real time.

The protocol is **identical to what the browser sends**, so any client that
can speak WebSocket can connect — Windows apps (C#/C++), Python scripts,
microcontrollers with a TLS stack, serial-port-to-WS bridges, etc.

---

## 1. Install

```bash
cd client-example
npm install
```

This package has **only one dependency: `ws`** — no native modules, no C++
toolchain required. You do, however, need **`ffmpeg` available on PATH**
for audio capture / transcoding. Verify with:

```bash
node src/check-ffmpeg.mjs
# or just: ffmpeg -version
```

## 1.1 Configure via `.env` (optional)

Instead of passing flags every time, copy `.env.example` to `.env` and edit:

```bash
cp .env.example .env
# then edit .env with your editor
```

The client loads `.env` automatically on startup. Settings already exported
in your shell still win over `.env`, so you can do quick overrides like
`LIVE_TRANSLATE_TOKEN=xyz npm start`.

The most useful keys:

| Key | What it does |
|---|---|
| `LIVE_TRANSLATE_HOST` | Server hostname |
| `LIVE_TRANSLATE_PORT` | Server port (TLS) |
| `LIVE_TRANSLATE_SECURE` | `true` (use `wss://`) / `false` (use `ws://` for local dev) |
| `LIVE_TRANSLATE_TOKEN` | Shared secret — only needed if server's `CLIENT_AUTH_TOKEN` is set |
| `LIVE_TRANSLATE_SOURCE` | Source language (default `Auto`) |
| `LIVE_TRANSLATE_TARGET` | Target language |
| `LIVE_TRANSLATE_FFMPEG` | **Full path to ffmpeg.** Leave blank to auto-detect from PATH |
| `LIVE_TRANSLATE_MIC` | Microphone to use. Leave blank to scan + interactively pick at startup. Can be a device name or a pure number (`1`, `2`, …) to pick by index from the scanned list. |
| `LIVE_TRANSLATE_SOURCE_MODE` | `mic` / `file` / `stdin` |
| `LIVE_TRANSLATE_FILE` | Audio file path when `SOURCE_MODE=file` |

**ffmpeg path resolution order:**
1. `LIVE_TRANSLATE_FFMPEG` from `.env` or shell (if non-empty)
2. Probe `ffmpeg` in `PATH`
3. Probe common install locations per OS
4. If nothing works, print install instructions and exit

Install ffmpeg:

| Platform | Command |
|---|---|
| Windows | `winget install Gyan.FFmpeg` (or download from gyan.dev/ffmpeg/builds) |
| macOS | `brew install ffmpeg` |
| Debian/Ubuntu | `sudo apt install ffmpeg` |
| Fedora | `sudo dnf install ffmpeg` |
| Arch | `sudo pacman -S ffmpeg` |

The script auto-detects platform-specific ffmpeg input flags (ALSA on
Linux, AVFoundation on macOS, DirectShow on Windows). To use a non-default
microphone, set `LIVE_TRANSLATE_MIC=<name>` (or `<index>` on macOS).

## 2. Run

### Pick an audio source

| Flag | Audio comes from |
|---|---|
| `--source=mic` *(default)* | host default microphone via ffmpeg |
| `--source=file --file=path/to/audio` | any audio file ffmpeg can decode; transcoded to 16 kHz mono Int16 PCM |
| `--source=stdin` | raw Int16 LE mono PCM at 16 kHz piped to stdin (use this if you want to bypass ffmpeg entirely) |

### Examples

Live microphone:

```bash
npm start                              # default: --source=mic
# or: node src/index.mjs --source=mic
```

On first run with multiple mics available, you'll see:

```
Available microphones:
  [1] Microphone (Realtek High Definition Audio)
  [2] USB Microphone
  [3] Headset Mic (Blue Yeti)

Pick a microphone [1-3]: 2
[audio] selected mic [2] USB Microphone
```

If stdin isn't a TTY (e.g. CI / piped input), the first device is picked
automatically. To lock the choice, set `LIVE_TRANSLATE_MIC` in `.env` to
either a device name or a numeric index (`1`, `2`, ...).

Use a specific microphone (Windows / macOS):

```bash
# Windows — name from `ffmpeg -list_devices true -f dshow -i dummy`:
LIVE_TRANSLATE_MIC="USB Microphone" node src/index.mjs --source=mic

# macOS — index from `ffmpeg -f avfoundation -list_devices true -i ""`:
LIVE_TRANSLATE_MIC=1 node src/index.mjs --source=mic
```

Stream a WAV / MP3 / M4A / etc. file (any format ffmpeg understands):

```bash
npm run start:file -- --file=./sample.mp3
# or: node src/index.mjs --source=file --file=./sample.mp3
```

Pipe PCM from any source (e.g. screen recording, system audio loopback,
a different encoder) at 16 kHz:

```bash
# macOS — system audio loopback via "BlackHole" or similar:
ffmpeg -f avfoundation -i ":BlackHole 2ch" -ac 1 -ar 16000 -f s16le - \
  | node src/index.mjs --source=stdin

# Linux — PulseAudio monitor source:
pulseaudio --start
pacmd list-sources | grep monitor   # find the monitor source name
ffmpeg -f pulse -i <monitor-name> -ac 1 -ar 16000 -f s16le - \
  | node src/index.mjs --source=stdin

# Windows — WASAPI loopback (capture system audio):
ffmpeg -f wasapi -i "virtual-audio-capturer" -ac 1 -ar 16000 -f s16le - \
  | node src/index.mjs --source=stdin
```

### Defaults / overrides

| Variable / Flag | Default | Meaning |
|---|---|---|
| `LIVE_TRANSLATE_HOST` | `your-server.example.com` | Server hostname |
| `LIVE_TRANSLATE_PORT` | `443` | Server port (TLS) |
| `LIVE_TRANSLATE_SECURE` | `true` | Use `wss://` (set `false` for local dev on `:8966`) |
| `LIVE_TRANSLATE_SOURCE` | `Auto` | Source language (passed to server; `Auto` = Gemini autodetect) |
| `LIVE_TRANSLATE_TARGET` | `Chinese (Simplified)` | Target language |
| `LIVE_TRANSLATE_SILENCE_MS` | `1000` | Server-side VAD silence gap |
| `LIVE_TRANSLATE_TOKEN` | *(unset)* | Shared secret — only needed if server's `CLIENT_AUTH_TOKEN` is set |
| `LIVE_TRANSLATE_FFMPEG` | `ffmpeg` | Path to ffmpeg binary |
| `LIVE_TRANSLATE_MIC` | *(unset)* | Override the default mic name/index |
| `--source` | `mic` | `mic` / `file` / `stdin` |
| `--file` | *(unset)* | Path to audio file (required for `--source=file`) |

Example: local dev server with a token:

```bash
LIVE_TRANSLATE_SECURE=false \
LIVE_TRANSLATE_HOST=127.0.0.1 \
LIVE_TRANSLATE_PORT=8966 \
LIVE_TRANSLATE_TOKEN=please-change-me \
npm start
```

You'll see output like:

```
[14:22:11] connecting to wss://your-server.example.com/live?source=Auto&...
[14:22:11] [ws] connected
[14:22:11] [audio] source: mic (via ffmpeg)
[14:22:11] [audio] cmd: ffmpeg -f alsa -i default -ac 1 -ar 16000 -f s16le -acodec pcm_s16le -loglevel error pipe:1
[14:22:11] [audio] capturing microphone — speak into it. Ctrl+C to stop.
[14:22:14] [trans] 原: hello everyone, today we'll talk about AI
[14:22:14] [trans] 译: 大家好，今天我们来聊聊人工智能
[14:22:18] [usage] tokens 入=312 出=87
```

`Ctrl+C` flushes and closes cleanly.

## 3. Protocol (server ↔ client)

Every WebSocket frame is a single JSON object.

### Client → server

| Message | When |
|---|---|
| `{ audioBlob: "<base64>", mimeType: "audio/pcm;rate=16000" }` | Every ~100 ms with 1600 samples of Int16 LE mono PCM (16 kHz) |
| `{ action: "flush" }` | On shutdown — ask server to commit the current segment |
| `{ type: "pong" }` | Reply to server `{type:"ping"}` to keep the heartbeat alive |

### Server → client

| Message | When |
|---|---|
| `{ type: "connection_established" }` | Right after WebSocket upgrade |
| `{ type: "transcription", originalText, translatedText, finished }` | Streaming partial/final transcription + translation (concatenate them) |
| `{ type: "transcription_finished" }` | A segment is committed — the Web UI uses this to lock the line into history |
| `{ type: "transcription_interrupted" }` | User/session interrupted; clear any pending partial text |
| `{ type: "translation_audio", audio: "<base64>", mimeType }` | PCM audio of the translated speech (24 kHz mono Int16) |
| `{ type: "usage", inputTokens, outputTokens }` | Cumulative token usage for this session |
| `{ type: "error", message }` | Something went wrong (auth, upstream Gemini error, etc.) |
| `{ type: "ping" }` | Heartbeat — reply with `{type:"pong"}` within 30 s |

## 4. Embedded / serial-port screen

The intended use case: drive a small serial-port LCD / OLED display from
the translation stream.

```
WebSocket client (this script, or your own)  ──►  serial port  ──►  UART  ──►  display MCU
```

Steps on the client side:

1. Open the WebSocket as shown above.
2. On `{ type: "transcription", translatedText }`, take the `translatedText`
   and write it out the serial port (`COM5`, `/dev/ttyUSB0`, etc.).
3. (Optional) when `finished === true` and you've written the line, send a
   newline (`\r\n`) so the display advances to the next line.

Embedded frameworks with WebSocket + UART:

- **ESP32 Arduino**: [`WebSocketsClient`](https://github.com/Links2004/arduinoWebSockets) + `HardwareSerial`
- **STM32 + lwIP**: `libwebsockets` + HAL UART
- **Raspberry Pi / Linux SBC**: Node.js / Python script that bridges WS → `/dev/ttyAMA0`

## 5. Multiple clients

Each WebSocket connection = one independent Gemini session on the server.
You can run this client and a browser tab simultaneously; they will not
interfere, and each maintains its own source/target language and VAD
settings.