# Technical decisions and trade-offs

Each decision records the context, the choice and its cost. A production risk
assessment follows at the end.

## TD-1 — Two independent npm projects with a synced protocol contract

**Decision.** `backend/` and `frontend/` are separate npm projects. Each has its
own `package.json`, lockfile, `node_modules`, TypeScript, ESLint, Prettier and
Vitest configuration, Dockerfile and architecture check. Neither imports from
the other.

The protocol contract (Zod schemas, WebSocket events, binary audio codec,
constants) is copied into both projects as `src/shared`, imported through the
`@shared` path alias, with its tests in `tests/shared`:

- The **backend owns the contract**. `node scripts/sync-shared.mjs` copies its
  version to the frontend.
- `node scripts/sync-shared.mjs --check` fails if the copies differ. Run it in
  CI.
- `src/shared` may depend on nothing but `zod`. Each project's
  `check:architecture` enforces this.

**Why.** Each project can be installed, run, tested, deployed and even moved to
its own repository on its own. There is no workspace tool, and plain `npm` is
enough. Types and runtime validation still come from the same Zod schemas on
both sides.

**Cost.** The contract exists twice, so a change has to be synced. The drift
check turns a forgotten sync into a CI failure rather than a runtime protocol
mismatch.

The browser E2E suite needs both projects, so it expects the backend next to the
frontend (override with `E2E_BACKEND_DIR`). The production server is bundled with
esbuild (about 20 lines in `backend/scripts/build.mjs`) so that `dist/server.js`
contains the shared code and leaves npm dependencies external.

**Alternative considered.** A third `shared/` package that both projects link
with `file:../shared`. It gives a single copy, but the projects stop being
standalone. You also get two `zod` installs whose types TypeScript treats as
different, and Next.js has to be allowed to compile files outside its project
root.

## TD-2 — MVC on both sides, plus services, repositories and providers

**Decision.** Models hold domain rules. Controllers are thin coordinators.
Views present data. Workflows live in services, persistence in repositories, and
vendor integrations in providers. Each app has exactly one composition root
(`app.ts`, `composition/create-interview-app.ts`).

**Server views.** The server gained an `mvc/views` folder of presenter
functions, so the model → wire mapping has a single owner.

**Realtime output.** It flows through a `SessionEventSink` port that the
services define. The WebSocket layer implements it by delegating to controller
presenters, so services never see a socket.

**Cost.** There are more files than in a prototype. The import rules are
machine-checked (`npm run check:architecture` in each project) so the structure
does not erode.

## TD-3 — Fastify + `@fastify/websocket`

**Why.**

- Low overhead.
- First-class async handlers and hooks; `preValidation` rejects bad origins and
  over-capacity clients _before_ the WebSocket upgrade.
- Mature plugins for CORS, Helmet and rate limiting.
- `app.close()` lifecycle hooks for graceful shutdown.

## TD-4 — Binary audio frames, 16 kHz PCM16 resampled in an AudioWorklet

**Decision.** The browser mixes microphone and tab audio in one AudioContext.
An AudioWorklet resamples to 16 kHz mono PCM16 and emits 50 ms frames. Each
frame is sent as a binary WebSocket message with a 16-byte header carrying the
sequence number and the capture time.

**Alternatives considered.**

- _MediaRecorder + Opus/WebM chunks._ About 8× less bandwidth, but chunks
  arrive at 100–250 ms granularity with container overhead. Mixing sources is
  awkward, and not every STT provider accepts WebM.
- _Base64 PCM inside JSON._ Uniform validation, but 33% larger, and it costs CPU
  to encode and decode at 20 msgs/s.

**Why.**

- Lowest added latency (50 ms frames).
- Resampling runs off the main thread.
- Provider-agnostic input.
- Exact audio-time accounting, which powers both the transcription-latency
  metric and the audio-clock-driven Demo Mode.

**Cost.** About 256 kbit/s upstream per session, which is fine on broadband.
On constrained links, Opus would be the next step.

## TD-5 — Deepgram over its documented WebSocket protocol, not the SDK

**Decision.** `DeepgramTranscriptionProvider` uses `ws` directly against
`wss://api.deepgram.com/v1/listen`. It sends `interim_results`, `endpointing`,
`utterance_end_ms` and `vad_events`, uses `KeepAlive` and `CloseStream`, and
validates every incoming message with Zod.

**Why.**

- The protocol is small and stable.
- The adapter stays roughly 200 lines with full control over timeouts,
  keep-alives and graceful flush.
- It can be tested against a local fake server.
- It avoids coupling to a fast-moving SDK major version.

**Cost.** New Deepgram features have to be added to the query string and
message schema by hand.

## TD-6 — OpenAI Chat Completions streaming via the official SDK

**Decision.**

- Use `openai` v7 `chat.completions.create({ stream: true })` with
  `max_completion_tokens` and an `AbortSignal`.
- `OPENAI_BASE_URL` allows any OpenAI-compatible gateway.
- The default model is `gpt-4.1-mini`, a non-reasoning model chosen for low
  first-token latency.
- Temperature is sent only when configured, because some models reject
  non-default values.
- `reasoning_effort` is sent only when `OPENAI_REASONING_EFFORT` is set. It is
  meant for reasoning models such as `openai/gpt-oss-20b` on Groq's free tier,
  and non-reasoning models reject the field. Only `delta.content` is streamed,
  so hidden reasoning never reaches the UI.
- The provider name shown in the UI and in errors comes from the endpoint
  (`openai`, `groq` or `openai-compatible`), so a Groq answer is never labelled
  as OpenAI.

**Note.** The SDK ends its iterator silently on abort. The adapter turns that
into an explicit `AbortError`, so a cancellation can never look like a normal
completion. A unit test covers this.

## TD-7 — Heuristic, pause-based question detection

**Decision.** Detection is deterministic: weighted linguistic rules (section 6
of [architecture.md](./architecture.md)), evaluated on a pause. It runs within
milliseconds and needs no extra model call.

**Pause triggers**, any of which starts an evaluation:

- the provider's utterance end;
- a configurable silence timer;
- an audio-time gap between finals;
- a fast path when an end-of-speech segment ends with "?".

**Trade-offs.**

- _Latency vs. completeness._ The "?" fast path saves about one silence window
  but can split a two-part question. The second part then supersedes the first
  answer.
- _Precision._ Rules are English-centric, and rhetorical questions in a
  monologue can trigger answers. The confidence threshold, minimum word count
  and duplicate window are configurable.
- _Upgrade path._ Add an LLM or small-classifier second stage only for
  low-confidence utterances, so the common case stays fast.

## TD-8 — One in-flight answer per session; newest question wins

A newly detected question aborts the current answer. Every request runs under
`AbortSignal.any([cancel, timeout])`, so upstream requests always end. The
alternative, queueing answers, produces stale advice in a live conversation.

## TD-9 — Demo Mode reuses the real pipeline, paced by the audio clock

The mock STT is a scripted interview that advances only as fast as _audio
actually arrives_. With no audio there is no transcript, so Demo Mode exercises
capture, framing, WebSocket, ingestion, transcription handling, detection and
answer streaming exactly as Live Mode does.

The mock LLM streams coaching-style answers with `[placeholders]` rather than
invented facts. Every simulated artefact is flagged `simulated: true`, and the
UI shows "Simulated transcript" and "Simulated answer" badges.

A "Simulated input" audio source streams silence, for machines without a
microphone.

## TD-10 — Bounded in-memory repositories

The POC has no database, as the brief requires. Repositories sit behind
interfaces, cap entries per interview, evict the oldest idle interview when
full, and expire idle interviews after 2 h with cascade delete. Swapping in
Postgres or Redis is a new class wired in `app.ts`.

## TD-11 — Tiny external store instead of a state library

The UI state is one object with a handful of slices. The ~40-line store
consists of:

- `getState`, `setState` with a shallow merge, and `subscribe`;
- `useSyncExternalStore` with slice selectors for re-render isolation.

That covers what Zustand would provide for this app, without the dependency.
Controllers stay framework-free and testable without React.

## TD-12 — Toolchain pins

| Tool           | Version   | Reason                                                                                                        |
| -------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| Next.js        | 16.4      | Latest stable.                                                                                                |
| React          | 19.3      |                                                                                                               |
| Tailwind CSS   | 4.3       |                                                                                                               |
| Fastify        | 5.12      |                                                                                                               |
| Zod            | 4.6       |                                                                                                               |
| Vitest         | 5.1       |                                                                                                               |
| Playwright     | 1.65      |                                                                                                               |
| **TypeScript** | **5.9.3** | typescript-eslint 8.x supports `<6.1`, so TypeScript 7 is not yet usable with it.                             |
| **ESLint**     | **9.39**  | `eslint-plugin-react`, `-import` and `-jsx-a11y` (used by `eslint-config-next`) do not support ESLint 10 yet. |

## TD-13 — Runtime backend URL

`app/page.tsx` is dynamic and reads `PUBLIC_SERVER_URL` at request time. One
build or image therefore works in every environment, which avoids the usual
`NEXT_PUBLIC_*` build-time baking problem.

## TD-14 — Resumable sessions

When a socket drops without a clean close:

- The session is suspended for `SESSION_RESUME_GRACE_MS`.
- Provider streams stay open via KeepAlive.
- Question detection is paused and in-flight answers are cancelled.

On reconnect, the client sends `session.start` with `resumeSessionId` and the
transcript continues where it left off. A resume on a second connection takes
over the session and closes the stale socket with `4000`.

---

## Production risk assessment

| #   | Risk                                                                                                            | Impact                     | Likelihood                   | Mitigation in this codebase                                                                                | Before production                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Policy and ethics.** Using AI assistance in a live interview can breach employer or platform rules.           | High (reputational, legal) | Medium                       | Clear labelling; answers are guidance with placeholders, never fabricated experience.                      | Legal review, terms of use, explicit user acknowledgement; consider a "practice mode" positioning.                            |
| 2   | **No authentication.** Interview ids (UUIDv4) act as capability tokens.                                         | High                       | High                         | Unguessable ids, origin checks, rate limits, no context echo.                                              | Auth (OIDC), per-user ownership checks, short-lived signed WebSocket tickets.                                                 |
| 3   | **PII sent to third parties.** Resume and job description go to OpenAI; audio goes to Deepgram.                 | High                       | Certain in Live Mode         | No logging of content (redaction + `toJSON` guard); in-memory only; TTL purge; `DELETE` endpoint.          | DPAs, data-residency choice, retention policy, consent UI, zero-retention API options.                                        |
| 4   | **Single-instance, in-memory state.** Restarts lose sessions; no horizontal scaling.                            | Medium                     | High                         | Graceful shutdown; client resume.                                                                          | Sticky sessions at the load balancer; Redis for session metadata and transcripts; a durable store for history.                |
| 5   | **Speaker attribution.** Mic + tab audio is mixed, so the candidate's own speech can be detected as a question. | Medium                     | Medium                       | Declarative "what I did…" phrasing is filtered; headphones are advised.                                    | Send mic and tab as separate channels (Deepgram multichannel) and detect on the interviewer channel only, or use diarisation. |
| 6   | **Detection accuracy.** English-only heuristics; rhetorical questions; split questions.                         | Medium                     | Medium                       | Configurable thresholds, duplicate suppression, supersede-on-new-question, 43 detection unit tests.        | Evaluate on real transcripts; add a classifier second stage for low-confidence cases; multilingual support.                   |
| 7   | **Provider outages and latency spikes.**                                                                        | Medium                     | Medium                       | STT reconnect (3 attempts, audio offset preserved); LLM timeout + cancellation; errors surfaced to the UI. | Circuit breakers, fallback models/providers, retry budgets, status page.                                                      |
| 8   | **Cost runaway.** Long sessions, many answers.                                                                  | Medium                     | Medium                       | One in-flight answer per session; rate limits; bounded tokens (`OPENAI_MAX_OUTPUT_TOKENS`).                | Per-user quotas, max session duration, usage metering and alerting.                                                           |
| 9   | **Browser support.** Tab audio needs Chromium; Safari's AudioWorklet and display-capture limits.                | Low–Medium                 | Medium                       | Feature detection; tab options disabled when unsupported; clear errors.                                    | Browser matrix testing; fallback capture path (MediaRecorder).                                                                |
| 10  | **Transport security.**                                                                                         | High                       | Low (with proper deployment) | Origin allow-list, Helmet, size limits, Zod validation.                                                    | TLS termination (wss/https), CSP for the web app, secret manager instead of `.env`.                                           |
| 11  | **Observability.** Metrics are in-memory and per-interview.                                                     | Low                        | High                         | Latency diagnostics in the UI and over REST; structured pino logs.                                         | Export to OpenTelemetry/Prometheus; tracing across STT/LLM calls; SLO alerts.                                                 |
| 12  | **Clock skew** distorts `audioIngestion`.                                                                       | Low                        | Medium                       | RTT-based offset estimation; implausible values discarded.                                                 | Fine for diagnostics; server-side receive timestamps for SLOs.                                                                |
