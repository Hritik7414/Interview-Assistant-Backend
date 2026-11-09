import {
  CreateInterviewRequestSchema,
  InterviewContextPatchSchema,
  InterviewIdParamsSchema,
} from '@shared';
import type { z } from 'zod';

/** Request schemas for the interview REST resources (single source: src/shared). */
export const CreateInterviewBodySchema = CreateInterviewRequestSchema;
export const InterviewParamsSchema = InterviewIdParamsSchema;
export const UpdateContextBodySchema = InterviewContextPatchSchema;

export type CreateInterviewBody = z.output<typeof CreateInterviewBodySchema>;
export type InterviewParams = z.output<typeof InterviewParamsSchema>;
export type UpdateContextBody = z.output<typeof UpdateContextBodySchema>;
