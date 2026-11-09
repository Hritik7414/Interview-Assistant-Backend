import type {
  CapabilitiesDTO,
  InterviewContextPatch,
  InterviewMode,
  InterviewSummaryDTO,
  LatencySnapshot,
  SessionPingEvent,
  SessionStartEvent,
  SessionStopEvent,
} from '@shared';
import type { ProviderCatalog } from '../../providers/provider.registry';
import type { InterviewService } from '../../services/interview.service';
import type {
  InterviewSessionService,
  SessionEventSink,
  SessionInfo,
  SessionStatusUpdate,
} from '../../services/interview-session.service';
import type { LatencyMetricsService } from '../../services/latency-metrics.service';
import type { HandlerResult } from '../../utils/async-handler';
import { AppError, NotFoundError } from '../../utils/errors';
import type { CreateInterviewBody } from '../../validators/interview.validator';
import { toCapabilitiesDTO, toInterviewSummary } from '../views/interview.view';
import { sessionErrorEvent, sessionReadyEvent, sessionStatusEvent } from '../views/session.view';
import type { RealtimeClient, RealtimeContext } from './controller.types';

/** Interview REST resources and the realtime session lifecycle (start / stop / ping). */
export class InterviewController {
  constructor(
    private readonly deps: {
      interviews: InterviewService;
      sessions: InterviewSessionService;
      metrics: LatencyMetricsService;
      providers: ProviderCatalog;
      silenceThresholdMs: number;
    },
  ) {}

  // ── REST ──────────────────────────────────────────────────────────────────

  capabilities(): HandlerResult<CapabilitiesDTO> {
    const describeMode = (mode: InterviewMode) => ({
      ...this.deps.providers.availability(mode),
      ...this.deps.providers.describe(mode),
    });
    return {
      status: 200,
      body: toCapabilitiesDTO({
        modes: { demo: describeMode('demo'), live: describeMode('live') },
        silenceThresholdMs: this.deps.silenceThresholdMs,
      }),
    };
  }

  create(body: CreateInterviewBody): HandlerResult<{ interview: InterviewSummaryDTO }> {
    const interview = this.deps.interviews.create({ mode: body.mode, context: body.context });
    return { status: 201, body: { interview: this.summary(interview.id) } };
  }

  get(interviewId: string): HandlerResult<{ interview: InterviewSummaryDTO }> {
    return { status: 200, body: { interview: this.summary(interviewId) } };
  }

  updateContext(
    interviewId: string,
    patch: InterviewContextPatch,
  ): HandlerResult<{ interview: InterviewSummaryDTO }> {
    this.deps.interviews.updateContext(interviewId, patch);
    return { status: 200, body: { interview: this.summary(interviewId) } };
  }

  async remove(interviewId: string): Promise<HandlerResult<never>> {
    this.deps.interviews.get(interviewId);
    await this.deps.sessions.stopForInterview(interviewId, 'interview_deleted');
    this.deps.interviews.delete(interviewId);
    return { status: 204 };
  }

  metrics(interviewId: string): HandlerResult<{ metrics: LatencySnapshot }> {
    this.deps.interviews.get(interviewId);
    return { status: 200, body: { metrics: this.deps.metrics.snapshot(interviewId) } };
  }

  // ── Realtime ──────────────────────────────────────────────────────────────

  async startSession(
    context: RealtimeContext,
    payload: SessionStartEvent['payload'],
    sink: SessionEventSink,
  ): Promise<SessionInfo> {
    if (context.sessionId) {
      throw new AppError(
        'SESSION_ALREADY_ACTIVE',
        'This connection already has an active session',
        {
          statusCode: 409,
        },
      );
    }
    const info = payload.resumeSessionId
      ? this.deps.sessions.resume(payload.resumeSessionId, payload.interviewId, sink)
      : await this.deps.sessions.start({
          interviewId: payload.interviewId,
          format: payload.audio,
          sink,
        });

    context.client.send(sessionReadyEvent(info));
    const status = this.deps.sessions.statusOf(info.sessionId);
    if (status) {
      context.client.send(
        sessionStatusEvent(info.sessionId, {
          ...status,
          reason: info.resumed ? 'resumed' : 'started',
        }),
      );
    }
    return info;
  }

  async stopSession(context: RealtimeContext, payload: SessionStopEvent['payload']): Promise<void> {
    if (!context.sessionId || context.sessionId !== payload.sessionId) {
      throw new NotFoundError(
        'No active session with that id on this connection',
        'SESSION_NOT_FOUND',
      );
    }
    await this.deps.sessions.stop(context.sessionId, payload.reason ?? 'client_requested');
  }

  ping(context: RealtimeContext, payload: SessionPingEvent['payload'], receivedAt: number): void {
    const status = context.sessionId ? this.deps.sessions.statusOf(context.sessionId) : null;
    context.client.send(
      sessionStatusEvent(
        context.sessionId,
        { state: status?.state ?? 'idle', reason: null },
        { clientSentAt: payload.clientSentAt, serverReceivedAt: receivedAt },
      ),
    );
  }

  // ── Presenters ────────────────────────────────────────────────────────────

  presentStatus(client: RealtimeClient, sessionId: string, update: SessionStatusUpdate): void {
    client.send(sessionStatusEvent(sessionId, update));
  }

  presentError(client: RealtimeClient, sessionId: string | null, error: AppError): void {
    client.send(sessionErrorEvent(sessionId, error));
  }

  private summary(interviewId: string): InterviewSummaryDTO {
    const interview = this.deps.interviews.get(interviewId);
    return toInterviewSummary(interview, this.deps.interviews.stats(interviewId));
  }
}
