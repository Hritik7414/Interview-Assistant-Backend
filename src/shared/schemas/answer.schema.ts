import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.schema';
import { ProviderDescriptorSchema } from './provider.schema';

export const AnswerStatusSchema = z.enum([
  'pending',
  'streaming',
  'completed',
  'cancelled',
  'failed',
]);
export const FinishReasonSchema = z.enum(['stop', 'length', 'cancelled', 'error']);

export const AnswerSchema = z.object({
  id: IdSchema,
  questionId: IdSchema,
  text: z.string(),
  status: AnswerStatusSchema,
  finishReason: FinishReasonSchema.nullable(),
  provider: ProviderDescriptorSchema,
  startedAt: TimestampSchema,
  firstTokenAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  wordCount: z.number().int().nonnegative(),
  errorMessage: z.string().nullable(),
});

export const AnswersResponseSchema = z.object({
  answers: z.array(AnswerSchema),
});
