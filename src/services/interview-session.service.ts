import type {
  AudioChunkEvent,
  AudioFormat,
  AudioStats,
  InterviewMode,
  LatencySnapshot,
  SessionState,
} from '@shared';
import type { Answer } from '../mvc/models/answer.model';
import type { Interview } from '../mvc/models/interview.model';
import type { Question } from '../mvc/models/question.model';
import { recentTranscriptText, type TranscriptSegment } from '../mvc/models/transcript.model';
import type {
  ProviderCatalog,
  ProviderDescriptors,
  ProviderSet,
} from '../providers/provider.registry';
import { runDetached } from '../utils/async-handler';
import { type AppError, NotFoundError, ProviderError } from '../utils/errors';
import type { Logger } from '../utils/logger';
import type { Clock, IdGenerator } from '../utils/runtime';
import type { AnswerGenerationService } from './answer-generation.service';
import type { AudioIngestOutcome, AudioStreamService } from './audio-stream.service';
import type { InterviewService } from './interview.service';
import type { LatencyMetricsService } from './latency-metrics.service';
import type { QuestionDetectionService, QuestionDetector } from './question-detection.service';
import type { TranscriptionService, TranscriptionSessionHandlers } from './transcription.service';

export interface SessionStatusUpdate {
  state: SessionState;
  reason: string | null;
  metrics?: LatencySnapshot;
  audio?: AudioStats;
}

/**
 * Output port of a session. The transport layer implements it (WebSocket today);
 * services only ever speak in domain objects.
 */
export interface SessionEventSink {
  status(sessionId: string, update: SessionStatusUpdate): void;
  transcriptPartial(segment: TranscriptSegment): void;
  transcriptFinal(segment: TranscriptSegment): void;
  questionDetected(question: Question): void;
  answerStarted(answer: Answer): void;
  answerDelta(answer: Answer, delta: string, index: number): void;
  answerCompleted(answer: Answer): void;
  error(error: AppError): void;
}

export interface SessionInfo {
  sessionId: string;
  interviewId: string;
  mode: InterviewMode;
  resumed: boolean;
  providers: ProviderDescriptors;
  audio: AudioFormat;
  silenceThresholdMs: number;
}

export interface StartSessionInput {
  interviewId: string;
  format: AudioFormat;
  sink: SessionEventSink;
}

interface SessionRuntime {
  id: string;
  interview: Interview;
  providers: ProviderSet;
  format: AudioFormat;
  state: SessionState;
  sink: SessionEventSink | null;
  detector: QuestionDetector;
  statusTimer: NodeJS.Timeout | null;
  stopping: Promise<void> | null;
}

const ACTIVE_STATES: ReadonlySet<SessionState> = new Set(['listening', 'thinking', 'answering']);

/**
 * Orchestrates one realtime session:
 * audio → transcription → question detection → answer generation → sink.
 * Transport-agnostic, so the whole pipeline is testable without WebSockets.
 */
export class InterviewSessionService {
  private readonly sessions = new Map<string, SessionRuntime>();

  constructor(
    private readonly deps: {
      interviews: InterviewService;
      audio: AudioStreamService;
      transcription: TranscriptionService;
      detection: QuestionDetectionService;
      answers: AnswerGenerationService;
      metrics: LatencyMetricsService;
      providers: ProviderCatalog;
      config: { statusIntervalMs: number; recentTranscriptChars: number };
      logger: Logger;
      ids: IdGenerator;
      now: Clock;
    },
  ) {}

  get activeCount(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async start(input: StartSessionInput): Promise<SessionInfo> {
    const { interviews, providers, audio, transcription, detection } = this.deps;
    const interview = interviews.get(input.interviewId);
    const providerSet = providers.resolve(interview.mode);
    const sessionId = this.deps.ids();
    interviews.attachSession(interview.id, sessionId);

    const runtime: SessionRuntime = {
      id: sessionId,
      interview,
      providers: providerSet,
      format: input.format,
      state: 'starting',
      sink: input.sink,
      detector: detection.createDetector({
        sessionId,
        interviewId: interview.id,
        onQuestion: (question) => this.handleQuestion(runtime, question),
      }),
      statusTimer: null,
      stopping: null,
    };
    this.sessions.set(sessionId, runtime);
    audio.register(sessionId, interview.id, input.format);

    try {
      await transcription.open({
        sessionId,
        interviewId: interview.id,
        provider: providerSet.transcription,
        format: input.format,
        handlers: this.transcriptionHandlers(runtime),
      });
    } catch (error) {
      this.sessions.delete(sessionId);
      audio.unregister(sessionId);
      runtime.detector.dispose();
      interviews.detachSession(interview.id, sessionId);
      throw error;
    }

    // Set silently: the transport announces `session.ready` first, then the status snapshot.
    runtime.state = 'listening';
    runtime.statusTimer = setInterval(
      () => this.emitStatus(runtime),
      this.deps.config.statusIntervalMs,
    );
    runtime.statusTimer.unref();
    this.deps.logger.info(
      { sessionId, interviewId: interview.id, mode: interview.mode },
      'Session started',
    );
    return this.info(runtime, false);
  }

  /** Re-attaches a suspended session to a new transport after a reconnect. */
  resume(sessionId: string, interviewId: string, sink: SessionEventSink): SessionInfo {
    const runtime = this.sessions.get(sessionId);
    if (!runtime || runtime.interview.id !== interviewId || runtime.stopping) {
      throw new NotFoundError('Session not found or already ended', 'SESSION_NOT_FOUND');
    }
    runtime.sink = sink;
    this.deps.audio.resetSequence(sessionId);
    runtime.state = 'listening';
    this.deps.logger.info({ sessionId }, 'Session resumed');
    return this.info(runtime, true);
  }

  /** Transport dropped unexpectedly: keep provider streams, pause detection and answers. */
  suspend(sessionId: string): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime || runtime.stopping) return;
    runtime.sink = null;
    runtime.detector.reset();
    this.deps.answers.cancel(sessionId, 'session_suspended');
    runtime.state = 'suspended';
    this.deps.logger.info({ sessionId }, 'Session suspended');
  }

  ingestAudio(sessionId: string, frame: AudioChunkEvent): AudioIngestOutcome {
    const runtime = this.sessions.get(sessionId);
    if (!runtime || !ACTIVE_STATES.has(runtime.state)) {
      return { accepted: false, reason: 'unknown_session' };
    }
    return this.deps.audio.ingest(sessionId, frame);
  }

  cancelAnswer(sessionId: string, answerId?: string): boolean {
    return this.deps.answers.cancel(sessionId, 'client_cancelled', answerId);
  }

  statusOf(sessionId: string): SessionStatusUpdate | null {
    const runtime = this.sessions.get(sessionId);
    return runtime ? this.statusUpdate(runtime) : null;
  }

  async stop(sessionId: string, reason: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return;
    if (!runtime.stopping) runtime.stopping = this.teardown(runtime, reason);
    return runtime.stopping;
  }

  async stopForInterview(interviewId: string, reason: string): Promise<void> {
    const targets = [...this.sessions.values()].filter(
      (runtime) => runtime.interview.id === interviewId,
    );
    await Promise.all(targets.map((runtime) => this.stop(runtime.id, reason)));
  }

  async stopAll(reason: string): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.stop(sessionId, reason)));
  }

  private async teardown(runtime: SessionRuntime, reason: string): Promise<void> {
    if (runtime.statusTimer) clearInterval(runtime.statusTimer);
    runtime.detector.dispose();
    this.deps.answers.cancel(runtime.id, 'session_stopped');
    // Closing flushes the provider; late final segments still reach the client.
    await this.deps.transcription.close(runtime.id);
    this.deps.audio.unregister(runtime.id);
    this.deps.interviews.detachSession(runtime.interview.id, runtime.id);
    this.setState(runtime, 'stopped', reason);
    this.sessions.delete(runtime.id);
    this.deps.logger.info({ sessionId: runtime.id, reason }, 'Session stopped');
  }

  private transcriptionHandlers(runtime: SessionRuntime): TranscriptionSessionHandlers {
    return {
      onPartial: (segment) => {
        runtime.sink?.transcriptPartial(segment);
        runtime.detector.notePartial(segment);
      },
      onFinal: (segment) => {
        runtime.sink?.transcriptFinal(segment);
        runtime.detector.addFinal(segment);
      },
      onUtteranceEnd: () => runtime.detector.onUtteranceEnd(),
      onSpeechStarted: () => undefined,
      onError: (error, info) => {
        runtime.sink?.error(error);
        if (info.fatal) {
          runDetached(
            () => this.stop(runtime.id, 'transcription_failed'),
            (stopError) => this.deps.logger.error({ err: stopError }, 'Failed to stop session'),
          );
        }
      },
    };
  }

  private handleQuestion(runtime: SessionRuntime, question: Question): void {
    if (!runtime.sink || !ACTIVE_STATES.has(runtime.state)) return;
    runtime.sink.questionDetected(question);
    this.setState(runtime, 'thinking', null);

    const recentTranscript = recentTranscriptText(
      this.deps.transcription.recentSegments(runtime.interview.id, 40),
      this.deps.config.recentTranscriptChars,
    );
    runDetached(
      () =>
        this.deps.answers.generate({
          sessionId: runtime.id,
          interview: runtime.interview,
          question,
          recentTranscript,
          llm: runtime.providers.llm,
          handlers: {
            onStarted: (answer) => runtime.sink?.answerStarted(answer),
            onDelta: (answer, delta, index) => {
              if (index === 0 && runtime.state === 'thinking')
                this.setState(runtime, 'answering', null);
              runtime.sink?.answerDelta(answer, delta, index);
            },
            onCompleted: (answer) => this.handleAnswerCompleted(runtime, answer),
          },
        }),
      (error) =>
        this.deps.logger.error({ err: error, sessionId: runtime.id }, 'Answer pipeline crashed'),
    );
  }

  private handleAnswerCompleted(runtime: SessionRuntime, answer: Answer): void {
    runtime.sink?.answerCompleted(answer);
    if (answer.status === 'failed') {
      runtime.sink?.error(
        new ProviderError(
          'LLM_PROVIDER_ERROR',
          answer.provider.name,
          answer.errorMessage ?? 'Answer generation failed',
        ),
      );
    }
    if (!this.deps.answers.isGenerating(runtime.id) && ACTIVE_STATES.has(runtime.state)) {
      this.setState(runtime, 'listening', null);
    }
  }

  private setState(runtime: SessionRuntime, state: SessionState, reason: string | null): void {
    if (runtime.state === state && reason === null) return;
    runtime.state = state;
    runtime.sink?.status(runtime.id, { ...this.statusUpdate(runtime), reason });
  }

  private emitStatus(runtime: SessionRuntime): void {
    runtime.sink?.status(runtime.id, this.statusUpdate(runtime));
  }

  private statusUpdate(runtime: SessionRuntime): SessionStatusUpdate {
    const audio = this.deps.audio.stats(runtime.id);
    return {
      state: runtime.state,
      reason: null,
      metrics: this.deps.metrics.snapshot(runtime.interview.id),
      ...(audio ? { audio } : {}),
    };
  }

  private info(runtime: SessionRuntime, resumed: boolean): SessionInfo {
    return {
      sessionId: runtime.id,
      interviewId: runtime.interview.id,
      mode: runtime.interview.mode,
      resumed,
      providers: {
        transcription: runtime.providers.transcription.descriptor,
        llm: runtime.providers.llm.descriptor,
      },
      audio: runtime.format,
      silenceThresholdMs: this.deps.detection.config.silenceThresholdMs,
    };
  }
}
