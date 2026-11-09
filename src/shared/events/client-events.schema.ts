import { z } from 'zod';
import { IdSchema } from '../schemas/common.schema';
import { AudioFormatSchema } from '../schemas/provider.schema';
import { CLIENT_EVENT } from './event-names';

/** Client → server events carried as JSON text frames. */
export const SessionStartEventSchema = z.object({
  type: z.literal(CLIENT_EVENT.SESSION_START),
  payload: z.object({
    interviewId: IdSchema,
    /** Set when reconnecting to re-attach to a suspended session. */
    resumeSessionId: IdSchema.optional(),
    audio: AudioFormatSchema,
  }),
});

export const SessionStopEventSchema = z.object({
  type: z.literal(CLIENT_EVENT.SESSION_STOP),
  payload: z.object({
    sessionId: IdSchema,
    reason: z.string().max(120).optional(),
  }),
});

export const SessionPingEventSchema = z.object({
  type: z.literal(CLIENT_EVENT.SESSION_PING),
  payload: z.object({
    clientSentAt: z.number().nonnegative(),
  }),
});

export const AnswerCancelEventSchema = z.object({
  type: z.literal(CLIENT_EVENT.ANSWER_CANCEL),
  payload: z.object({
    sessionId: IdSchema,
    answerId: IdSchema.optional(),
  }),
});

export const ClientJsonEventSchema = z.discriminatedUnion('type', [
  SessionStartEventSchema,
  SessionStopEventSchema,
  SessionPingEventSchema,
  AnswerCancelEventSchema,
]);

export type SessionStartEvent = z.infer<typeof SessionStartEventSchema>;
export type SessionStopEvent = z.infer<typeof SessionStopEventSchema>;
export type SessionPingEvent = z.infer<typeof SessionPingEventSchema>;
export type AnswerCancelEvent = z.infer<typeof AnswerCancelEventSchema>;
export type ClientJsonEvent = z.infer<typeof ClientJsonEventSchema>;

/**
 * `audio.chunk` travels as a binary frame (see audio-frame.ts); this is its decoded form.
 * The connection identifies the session, so no session id is repeated per chunk.
 */
export interface AudioChunkEvent {
  type: typeof CLIENT_EVENT.AUDIO_CHUNK;
  seq: number;
  /** Capture time in epoch ms, already adjusted by the client to the server clock. */
  capturedAt: number;
  pcm: Uint8Array;
}

export type ClientEvent = ClientJsonEvent | AudioChunkEvent;
