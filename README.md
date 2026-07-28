<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Live Translate

Real-time speech-to-speech translation powered by **Gemini Live Translate**.

The project is split into two parts:

- **`server.ts` + root `package.json`** — the Node.js / Express / `ws` backend that
  proxies WebSocket traffic between the browser (or any external client) and
  the upstream Gemini Live WebSocket.
- **`frontend/`** — a Vite + React + Tailwind SPA. The browser app users see.
- **`client-example/`** — a small Node.js reference client that demonstrates
  how to talk to the same `/live` WebSocket from outside the browser. Useful
  as a starting point for desktop apps, console tools, or serial-port
  bridges.

Every WebSocket connection is its own independent Gemini session, so the
Web UI and one or more external clients can run side-by-side without
interfering.

## Repository layout

```
.
├── server.ts                  Backend (HTTP + WS /live)
├── package.json               Backend scripts & deps
├── .env / .env.example        Gemini key, ports, optional CLIENT_AUTH_TOKEN
├── nginx.conf.example         TLS + WS reverse proxy example
├── frontend/                  React + Vite SPA (browser)
│   ├── package.json
│   ├── index.html
│   ├── vite.config.ts
│   ├── public/                pcm-worklet.js, translation.png
│   └── src/                   App.tsx, main.tsx, index.css, settings.ts
└── client-example/            Node.js console reference client
    ├── package.json
    └── src/index.mjs          microphone → WS → stdout
```

## Quick start

### 1. Backend

```bash
# from repo root
npm install
cp .env.example .env
# edit .env: GEMINI_API_KEY=...
npm run dev
```

That starts the server on `127.0.0.1:8966` (configurable via `.env`).
The Vite dev server is embedded — open `http://127.0.0.1:8966/` and you
should see the React UI.

### 2. Production build

```bash
npm run build
# builds frontend/dist and bundles server.ts → dist/server.cjs
npm run start
```

### 3. External client (optional)

```bash
cd client-example
npm install
npm start                # talks to wss://your-server.example.com/live by default
```

Override target with `LIVE_TRANSLATE_HOST=...`, `LIVE_TRANSLATE_PORT=...`,
`LIVE_TRANSLATE_SECURE=...`, `LIVE_TRANSLATE_TOKEN=...`, etc. See
`client-example/README.md` for the full protocol reference.

## Optional token authentication

Set `CLIENT_AUTH_TOKEN=some-secret` in `.env` to require an external
client to authenticate. When set, external clients must connect to `/live`
with `?token=some-secret`. Web browsers are unaffected.

Leave it empty to disable.

## Reverse proxy / production deploy

See `nginx.conf.example` for a reference config. The only path that
matters is `/live` — both Web and external clients hit it.