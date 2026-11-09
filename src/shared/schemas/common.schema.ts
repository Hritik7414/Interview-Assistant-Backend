import { z } from 'zod';

/** All entity identifiers are RFC 9562 UUIDs generated server-side. */
export const IdSchema = z.uuid();

/** Epoch milliseconds. */
export const TimestampSchema = z.number().nonnegative();

export const ErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'MALFORMED_MESSAGE',
  'MESSAGE_TOO_LARGE',
  'NOT_FOUND',
  'INTERVIEW_NOT_FOUND',
  'SESSION_NOT_FOUND',
  'SESSION_NOT_STARTED',
  'SESSION_ALREADY_ACTIVE',
  'CONFLICT',
  'LIVE_MODE_UNAVAILABLE',
  'UNSUPPORTED_AUDIO_FORMAT',
  'INVALID_AUDIO_FRAME',
  'RATE_LIMITED',
  'BACKPRESSURE',
  'ORIGIN_NOT_ALLOWED',
  'TOO_MANY_CONNECTIONS',
  'TRANSCRIPTION_PROVIDER_ERROR',
  'LLM_PROVIDER_ERROR',
  'INTERNAL_ERROR',
]);

export const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
