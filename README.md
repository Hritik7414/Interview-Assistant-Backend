# Cue — Real-Time Interview Assistant

Cue listens to a live interview, transcribes speech, detects interviewer questions, and streams concise answer suggestions grounded in the candidate's resume and job description. Answers target 60–90 words in 3–6 bullets.

## Features

- **Demo Mode** runs the end-to-end pipeline without API keys and labels simulated providers clearly.
- **Live Mode** uses Deepgram for streaming speech recognition and an OpenAI-compatible chat API for generated answers. The demo configuration uses Groq; provider keys stay on the backend.
- The frontend and backend are separate repositories, each with its own dependencies and environment file.

## Architecture and data flow

```text
Microphone / shared-tab audio
  → browser AudioWorklet (mix, resample to 16 kHz mono PCM16, 50 ms frames)
  → binary WebSocket to Fastify backend
  → Deepgram streaming transcription
  → pause-based question detection
  → OpenAI-compatible streaming chat API (Groq in the demo configuration)
  → answer tokens over WebSocket to the dashboard
```

The browser captures and frames audio. The backend owns provider credentials and coordinates transcription, detection, answer generation, session state, and latency metrics. Demo Mode swaps in scripted/mock providers while keeping the same session pipeline. See [architecture](docs/architecture.md), [MVC structure](docs/mvc-structure.md), and [WebSocket protocol](docs/websocket-protocol.md).

## Run from a clean machine

Requirements: Node.js 22.12 or newer, npm, and Git. Clone both `dev` branches into sibling folders named `backend` and `frontend`:

```bash
mkdir cue-project && cd cue-project
git clone -b dev https://github.com/Hritik7414/Interview-Assistant-Backend.git backend
git clone -b dev https://github.com/Hritik7414/Interview-Assistant-frontend.git frontend

cd backend
npm ci
cp .env.example .env
npm run dev
```

In a second terminal, from `cue-project`:

```bash
cd frontend
npm ci
cp .env.example .env
npm run dev
```

Open <http://localhost:3000>. On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`. The checked-in `.env.example` files are safe templates; `.env` files are ignored by Git. Demo Mode works without keys. To enable Live Mode, add `DEEPGRAM_API_KEY` and an LLM key to `backend/.env`, then restart the backend. The frontend does not need provider keys.

### Demo walkthrough

1. Select **Demo** mode (the dashboard labels simulated services).
2. Optionally enter resume/job context. Start listening and allow microphone access, or choose simulated input.
3. Observe live transcript, detected questions, and a streamed suggested answer. Stop an answer mid-stream or wait for subsequent scripted questions.
4. Review latency metrics, then stop the session.

For Live Mode, choose **Microphone + tab audio** and enable **Share tab audio** in the browser prompt. Headphones reduce feedback and duplicate capture.

### Configuration

Backend configuration is validated from `backend/.env`; see `backend/.env.example`. `DEEPGRAM_API_KEY` enables live transcription. `OPENAI_API_KEY` enables real generated answers; `OPENAI_BASE_URL` selects an OpenAI-compatible endpoint. For Groq, configure the API key, base URL, model, and (for a reasoning model) `OPENAI_REASONING_EFFORT` as described by the template. Without provider credentials, the clearly labelled Demo Mode remains available.

Frontend configuration is in `frontend/.env`; `PUBLIC_SERVER_URL` defaults to `http://localhost:4000`.

## Key decisions and trade-offs

- **Audio transport:** The browser sends 16 kHz mono PCM16 in 50 ms binary frames. This avoids the added chunk delay and provider/container constraints of MediaRecorder formats, and avoids Base64's size/CPU cost. It adds about 256 kbit/s upstream per session; Opus would be a useful option for constrained networks.
- **STT — Deepgram:** Its streaming WebSocket provides interim transcripts and pause/end-of-utterance signals needed for responsive detection. The backend uses the documented protocol directly, with explicit keepalive, flush, timeout, and message validation. This gives lifecycle control and avoids SDK-version coupling, at the cost of maintaining protocol handling when Deepgram adds features.
- **LLM — OpenAI-compatible streaming API:** The official OpenAI SDK supports streamed Chat Completions, cancellation, and configurable compatible endpoints. The default OpenAI model is selected for low first-token latency; this demo is configured for Groq's compatible API. This keeps provider selection configurable while preserving the same streaming path. The trade-off is dependence on external provider availability, model-specific settings, latency, and rate limits.
- **Question detection:** Deterministic English heuristics run when Deepgram signals an utterance end, a configurable silence timer/gap fires, or a final segment ends with a question mark. They need no extra model call and keep detection fast. Thresholds and duplicate suppression help tune precision; English-only rules can miss split questions or mistake rhetorical questions. A second-stage classifier for low-confidence cases is a planned improvement.
- **Answer policy:** Suggestions are short and grounded in supplied context; missing experience should be represented as a placeholder rather than invented. A new detected question cancels a stale in-flight answer so the dashboard prioritizes the latest question.

Detailed rationale and alternatives are in [technical decisions](docs/technical-decisions.md). The [production risk assessment](docs/submission-risks.md) covers privacy, security, reliability, and mitigations.

## Known limitations

- Detection is English-centric and heuristic; split or rhetorical questions can be missed or falsely triggered.
- Microphone and shared-tab audio are mixed, so the candidate's voice may be transcribed as interviewer speech.
- Session state and metrics are in memory; a backend restart loses active sessions, and the POC is single-instance.
- Live audio goes to Deepgram and resume/job context goes to the configured LLM provider. Production use needs explicit consent, retention controls, and privacy/legal review.
- The POC has no user authentication. Tab-audio capture depends on browser support (currently best in Chromium).
- Live behavior depends on third-party service availability, network quality, quotas, and keys.

## What I would build next with another week

1. Add clear recording consent, provider disclosure, retention controls, and a delete/export flow.
2. Evaluate question-detection precision and recall against a labelled set of interview transcripts; tune thresholds and add a low-confidence classifier only if evaluation supports it.
3. Keep microphone and tab audio as separate channels and attribute speakers so candidate speech is not treated as an interviewer question.
4. Add authentication, per-user/session quotas, and durable session storage with a deployment plan for multiple instances.
5. Add provider health/fallback handling and measure end-to-end latency and cost under realistic network conditions.

## Development checks

Run these within either project folder:

```bash
npm run typecheck
npm run lint
npm run check:architecture
npm test
npm run verify
```

For frontend browser tests, install Playwright Chromium once (`npx playwright install chromium`) and run `npm run test:e2e` in the frontend folder. The backend must be beside the frontend with dependencies installed. See [demo recording outline](docs/demo-script.md) for a short walkthrough.

## Repositories and documentation

- Backend: <https://github.com/Hritik7414/Interview-Assistant-Backend/tree/dev>
- Frontend: <https://github.com/Hritik7414/Interview-Assistant-frontend/tree/dev>
- [Architecture](docs/architecture.md)
- [MVC structure](docs/mvc-structure.md)
- [WebSocket protocol](docs/websocket-protocol.md)
- [Technical decisions](docs/technical-decisions.md)
- [Production risk assessment](docs/submission-risks.md)
- [Demo recording outline](docs/demo-script.md)
