# Cue backend

Fastify service for the Cue real-time interview assistant. It accepts browser
audio over WebSocket, streams it to speech-to-text, detects interviewer
questions, and streams concise answer suggestions back to the dashboard.

## Requirements

- Node.js 22.12 or newer
- npm
- The Cue frontend, or another client that follows the WebSocket protocol

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

The server listens on <http://localhost:4000>. Demo Mode works without API keys.
For Live Mode, add `DEEPGRAM_API_KEY` and optionally `OPENAI_API_KEY` to `.env`.
The OpenAI-compatible endpoint can be changed with `OPENAI_BASE_URL`.

## Checks

```bash
npm run typecheck
npm run lint
npm run check:architecture
npm test
```

`npm run build` bundles the production server to `dist/server.js`; `npm start`
runs it. Tests use fake providers and need no API credentials.

## Structure

- `src/config/` validates environment and server/provider configuration.
- `src/mvc/` contains domain models, REST/realtime controllers, presenters, and
  route registration.
- `src/services/` orchestrates sessions, transcription, question detection,
  answer generation, and latency metrics.
- `src/providers/` adapts Deepgram, OpenAI-compatible, and demo providers.
- `src/repositories/` provides bounded in-memory persistence for the POC.
- `src/websocket/` handles WebSocket transport, session binding, reconnects, and
  backpressure.
- `src/shared/` is the protocol source of truth. When using the complete project
  checkout, run `node scripts/sync-shared.mjs` from the repository root after
  changing this contract.
- `tests/` contains unit, integration, and protocol-contract tests.
