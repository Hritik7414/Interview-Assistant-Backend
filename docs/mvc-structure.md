# MVC structure

This document says what belongs in every major folder, what each layer may
depend on, and how the rules are enforced. Each project has its own rules in
`scripts/check-architecture.mjs` (`backend/` and `frontend/`), run as part of
`npm run verify`. A violation or a circular dependency fails the check.

## Backend — `backend/src`

| Folder            | Layer                | Responsibility                                                                                                                                                                  | May depend on                                                 |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `mvc/models`      | **Model**            | Entities and value objects (`Interview`, `InterviewContext`, `TranscriptSegment`, `Question`, `Answer`), invariants and state transitions, text normalisation, duplicate rules. | other models, `@shared` types                                 |
| `mvc/views`       | **View**             | Presenters: map models to the wire DTOs and server events (`toAnswerDTO`, `answerDeltaEvent`…). The API's "view" layer.                                                         | models, `@shared`, service _types_                            |
| `mvc/controllers` | **Controller**       | Thin request/message handlers: take validated input, call services, render through views, raise application errors. Also the realtime presenters used by the session sink.      | services, views, validators (types), `utils/errors`           |
| `mvc/routes`      | Transport (HTTP)     | Declarative route table: path → validation schema → controller method. No logic.                                                                                                | controllers, middleware, validators                           |
| `services`        | Application          | Workflows: session orchestration, transcription, question detection, answer generation, audio ingestion, metrics, interview lifecycle.                                          | models, repository and provider **interfaces**, utils         |
| `repositories`    | Persistence          | Data access behind interfaces; bounded in-memory implementations for the POC.                                                                                                   | models                                                        |
| `providers`       | Infrastructure       | Vendor adapters behind `TranscriptionProvider` / `LlmProvider` (Deepgram, OpenAI, mocks) plus the `ProviderRegistry` that picks a set per mode.                                 | provider interfaces, config types, utils                      |
| `websocket`       | Transport (realtime) | `@fastify/websocket` registration, origin/capacity checks, heartbeat, outbound backpressure, connection↔session binding, message routing to controllers.                        | controllers, services (session types), middleware, validators |
| `middleware`      | Cross-cutting        | Centralised error handling, Zod request validation, HTTP rate limiting, WebSocket token bucket.                                                                                 | utils                                                         |
| `validators`      | Cross-cutting        | Reusable request and WebSocket message schemas (sourced from `@shared`) and the binary/JSON message parser.                                                                     | `@shared`, zod                                                |
| `config`          | Cross-cutting        | Zod-validated environment, plus derived server and AI configuration objects.                                                                                                    | zod, `@shared`                                                |
| `utils`           | Cross-cutting        | Logger (with PII redaction), error hierarchy, async helpers (no floating promises), injectable clock and ids.                                                                   | models (`DomainError` only)                                   |
| `app.ts`          | Composition root     | The **only** place that instantiates concrete repositories, providers, services and controllers and wires them together.                                                        | everything                                                    |
| `server.ts`       | Entry point          | Loads env, builds the app, listens, graceful shutdown.                                                                                                                          | `app.ts`, config                                              |

### Why the server has `mvc/views`

In an API server, the _view_ is the representation sent to the client. Keeping
the model → DTO/event mapping in pure presenter functions means:

- controllers never hand-build JSON;
- models never learn about the wire format;
- the protocol shape has one owner.

### How realtime output flows without breaking the layering

`InterviewSessionService` emits domain objects into a `SessionEventSink`
interface, which it defines itself. `websocket.controller.ts` implements the
sink for each connection by delegating to the MVC controllers' presenters
(`TranscriptController.presentPartial`, `AnswerController.presentDelta`…).
Each presenter renders through a view and sends the result on the
`RealtimeClient` port.

The service never sees a socket, and the transport never contains workflow
logic.

## Frontend — `frontend/src`

| Folder                        | Layer            | Responsibility                                                                                                                                                                                                                 | May depend on                                        |
| ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `mvc/models`                  | **Model**        | Pure state transitions and rules: transcript reducers + utterance grouping, question and answer reducers (ordering, de-duplication), session lifecycle guards, display-status derivation, context validation, latency ratings. | `@shared`, `lib`, `types`                            |
| `mvc/views/*`                 | **View**         | Feature panels (dashboard, controls, context, question, answer, transcript, diagnostics). Render data from hooks, call hook actions, handle presentation-only interaction.                                                     | hooks, components, models (pure helpers), `lib`      |
| `mvc/controllers`             | **Controller**   | Framework-free classes handling UI actions and server events. They coordinate services and update the store through the models. `InterviewController` orchestrates the session; the others own one event family each.          | models, services (interfaces), store, `lib`, `types` |
| `services`                    | Infrastructure   | Browser integrations: Web Audio + AudioWorklet capture, typed WebSocket client (reconnect, heartbeat, clock sync, backpressure), REST client with response validation.                                                         | `@shared`, `lib`, `types`                            |
| `store`                       | State            | Minimal external store holding the UI state slices.                                                                                                                                                                            | models (initial states), `types`                     |
| `hooks`                       | Binding          | `useSyncExternalStore` selectors plus memoised controller actions for views.                                                                                                                                                   | store (types), controllers (via context), models     |
| `composition`                 | Composition root | `createInterviewApp`: the only place that instantiates services, store and controllers.                                                                                                                                        | everything below it                                  |
| `components/ui`               | Presentation     | shadcn/ui primitives (button, card, select, tabs…). No app knowledge.                                                                                                                                                          | `lib/utils`                                          |
| `components/layout`, `shared` | Presentation     | App header, status pill, empty state, segmented control, provider badge, `InterviewProvider`.                                                                                                                                  | ui, models (types), composition (provider only)      |
| `app`                         | Routing          | Next.js App Router entry: layout, page (reads the backend URL at request time), `/api/health`.                                                                                                                                 | components, views, `lib`                             |
| `lib`, `types`                | Cross-cutting    | Formatting helpers, constants, runtime config, shared UI types.                                                                                                                                                                | `@shared`                                            |
| `public/worklets`             | Asset            | The AudioWorklet processor (it must be plain JS served statically).                                                                                                                                                            | —                                                    |

## Shared contract — `src/shared` in each project

Both projects carry an identical copy, imported as `@shared`. The backend's copy
is the source of truth: edit it there, then run `node scripts/sync-shared.mjs`
from the repository root to copy it to the frontend. `--check` fails on drift.

| Folder      | Responsibility                                                                         |
| ----------- | -------------------------------------------------------------------------------------- |
| `schemas`   | Zod schemas for every DTO and request body; the single source of truth.                |
| `types`     | DTO types inferred from the schemas (`z.infer`), so types never drift from validation. |
| `events`    | Client/server event schemas, `createServerEvent`, the binary `audio.chunk` codec.      |
| `constants` | Audio format, protocol limits, context limits, answer guidelines, latency budgets.     |

## Enforced rules

`npm run check:architecture` checks 9 rules in the backend and 8 in the frontend.
In summary:

- Server **models** import no framework, SDK or infrastructure code.
- Server **controllers** never import repositories, vendor providers, `ws` or `openai`.
- **Routes** contain no service, repository or provider access.
- **Services** never import transport (Fastify, `ws`, routes, controllers, views,
  middleware) or concrete `*.provider` adapters.
- **Providers** and **repositories** are leaves and never import services or controllers.
- Web **models** and **controllers** import neither React nor Next.
- Web **views** never import services, controllers, the store or the composition root.
- Web **services** and the **store** import no React or MVC code.
- **UI primitives** have no application knowledge.
- **`src/shared`** depends only on `zod`, in both projects.
- There are **no circular dependencies** (Tarjan SCC over runtime imports).

## Architectural validation

These are the questions from the brief's architectural-validation step, answered
from the code and checked by tooling.

| Question                                       | Answer                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Does every file belong to the right layer?     | Yes. Folder rules above, enforced by `check-architecture`.                                                                           |
| Are controllers thin?                          | Yes. Server controller methods are 2–10 lines: validate, call a service, render a view.                                              |
| Is business logic isolated in services/models? | Yes. Detection heuristics, deduplication, the answer lifecycle and session orchestration live in services and models.                |
| Are models independent of transport and UI?    | Yes. Enforced: no Fastify/ws/SDK imports (server), no React/Next imports (web).                                                      |
| Are views free of business logic?              | Yes. Views render hook data. Rules such as `parseAnswerBlocks` and `groupUtterances` are model functions.                            |
| Are external SDKs isolated behind interfaces?  | Yes. Only `providers/*` import `ws` (Deepgram) and `openai`; services see `TranscriptionProvider` / `LlmProvider`.                   |
| Are repositories responsible for persistence?  | Yes. Services persist only through repository interfaces; in-memory implementations are wired in `app.ts`.                           |
| Do dependencies flow in the correct direction? | Yes. Transport → controllers → services → models / interfaces. Verified.                                                             |
| Any circular dependencies?                     | None. Verified by the SCC check.                                                                                                     |
| Are important services independently testable? | Yes. Every service takes its dependencies through the constructor (clock, ids, repositories, providers) and has isolated unit tests. |

## Where does new code go?

| You want to…                         | Put it in                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Add a field to an event or DTO       | `backend/src/shared/schemas` or `events`, sync to the frontend, then the server view, then the web model |
| Change how questions are recognised  | `backend/src/services/question-detection.heuristics.ts` (+ tests)                                        |
| Add another STT/LLM vendor           | New class implementing the provider interface in `providers/`; register it in `provider.registry.ts`     |
| Persist to a database                | New repository implementation; swap it in `app.ts`                                                       |
| Add a REST endpoint                  | Validator schema → controller method → route line                                                        |
| Add a dashboard panel                | `mvc/views/<feature>/`, data via a hook, actions via a controller                                        |
| Change how the UI reacts to an event | The relevant web controller + model reducer (+ unit test)                                                |
