import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.schema';

export const TranscriptSegmentSchema = z.object({
  id: IdSchema,
  text: z.string(),
  isFinal: z.boolean(),
  /** Audio-time offsets relative to the start of the session stream. */
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  /** True when the provider signalled the end of a spoken utterance. */
  speechFinal: z.boolean(),
  receivedAt: TimestampSchema,
});

export const TranscriptResponseSchema = z.object({
  segments: z.array(TranscriptSegmentSchema),
});
