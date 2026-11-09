import { z } from 'zod';
import { ErrorCodeSchema, IdSchema, TimestampSchema } from '../schemas/common.schema';
import { InterviewModeSchema } from '../schemas/interview.schema';
import { AudioFormatSchema, ProviderDescriptorSchema } from '../schemas/provider.schema';
import { TranscriptSegmentSchema } from '../schemas/transcript.schema';
import { QuestionSchema } from '../schemas/question.schema';
import { AnswerSchema } from '../schemas/answer.schema';
import { LatencySnapshotSchema } from '../schemas/metrics.schema';
import { AudioStatsSchema, SessionStateSchema } from '../schemas/session.schema';
import { SERVER_EVENT } from './event-names';

/** Every server event shares the same envelope: `{ type, sessionId, ts, payload }`. */
function serverEvent<TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  return z.object({
    type: z.literal(type),
    sessionId: IdSchema.nullable(),
    ts: TimestampSchema,
    payload,
  });
}

export const SessionReadyEventSchema = serverEvent(
  SERVER_EVENT.SESSION_READY,
  z.object({
    interviewId: IdSchema,
    resumed: z.boolean(),
    mode: InterviewModeSchema,
    providers: z.object({
      transcription: ProviderDescriptorSchema,
      llm: ProviderDescriptorSchema,
    }),
    audio: AudioFormatSchema.extend({ frameDurationMs: z.number().positive() }),
    detection: z.object({ silenceThresholdMs: z.number().int().positive() }),
    protocolVersion: z.number().int(),
  }),
);

export const TranscriptPartialEventSchema = serverEvent(
  SERVER_EVENT.TRANSCRIPT_PARTIAL,
  z.object({ segment: TranscriptSegmentSchema }),
);

export const TranscriptFinalEventSchema = serverEvent(
  SERVER_EVENT.TRANSCRIPT_FINAL,
  z.object({ segment: TranscriptSegmentSchema }),
);

export const QuestionDetectedEventSchema = serverEvent(
  SERVER_EVENT.QUESTION_DETECTED,
  z.object({ question: QuestionSchema }),
);

export const AnswerStartedEventSchema = serverEvent(
  SERVER_EVENT.ANSWER_STARTED,
  z.object({
    answerId: IdSchema,
    questionId: IdSchema,
    provider: ProviderDescriptorSchema,
    startedAt: TimestampSchema,
  }),
);

export const AnswerDeltaEventSchema = serverEvent(
  SERVER_EVENT.ANSWER_DELTA,
  z.object({
    answerId: IdSchema,
    delta: z.string(),
    /** Monotonic per answer; coalesced deltas may skip indexes. */
    index: z.number().int().nonnegative(),
  }),
);

export const AnswerCompletedEventSchema = serverEvent(
  SERVER_EVENT.ANSWER_COMPLETED,
  z.object({
    answer: AnswerSchema,
    latency: z.object({
      firstTokenMs: z.number().nullable(),
      totalMs: z.number(),
    }),
  }),
);

export const SessionStatusEventSchema = serverEvent(
  SERVER_EVENT.SESSION_STATUS,
  z.object({
    state: SessionStateSchema,
    reason: z.string().nullable().optional(),
    metrics: LatencySnapshotSchema.optional(),
    audio: AudioStatsSchema.optional(),
    /** Present when this status answers a `session.ping`. */
    pong: z
      .object({
        clientSentAt: z.number().nonnegative(),
        serverReceivedAt: TimestampSchema,
      })
      .optional(),
  }),
);

export const SessionErrorEventSchema = serverEvent(
  SERVER_EVENT.SESSION_ERROR,
  z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    recoverable: z.boolean(),
  }),
);

export const ServerEventSchema = z.discriminatedUnion('type', [
  SessionReadyEventSchema,
  TranscriptPartialEventSchema,
  TranscriptFinalEventSchema,
  QuestionDetectedEventSchema,
  AnswerStartedEventSchema,
  AnswerDeltaEventSchema,
  AnswerCompletedEventSchema,
  SessionStatusEventSchema,
  SessionErrorEventSchema,
]);

export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent['type'];
export type ServerEventOf<TType extends ServerEventType> = Extract<ServerEvent, { type: TType }>;
export type ServerEventPayload<TType extends ServerEventType> = ServerEventOf<TType>['payload'];

export function createServerEvent<TType extends ServerEventType>(
  type: TType,
  sessionId: string | null,
  payload: ServerEventPayload<TType>,
  ts: number = Date.now(),
): ServerEventOf<TType> {
  return { type, sessionId, ts, payload } as ServerEventOf<TType>;
}
