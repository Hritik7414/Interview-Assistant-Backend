import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.schema';

export const QuestionStatusSchema = z.enum([
  'detected',
  'answering',
  'answered',
  'cancelled',
  'failed',
]);

export const QuestionSchema = z.object({
  id: IdSchema,
  text: z.string(),
  confidence: z.number().min(0).max(1),
  /** Human-readable heuristics that fired, e.g. `question-mark`, `interrogative-start`. */
  reasons: z.array(z.string()),
  status: QuestionStatusSchema,
  utteranceEndedAt: TimestampSchema,
  detectedAt: TimestampSchema,
});

export const QuestionsResponseSchema = z.object({
  questions: z.array(QuestionSchema),
});
