import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.schema';
import { InterviewContextSchema } from './context.schema';
import { AudioFormatSchema, ProviderDescriptorSchema } from './provider.schema';

export const InterviewModeSchema = z.enum(['demo', 'live']);
export const InterviewStatusSchema = z.enum(['idle', 'active']);

export const CreateInterviewRequestSchema = z.object({
  mode: InterviewModeSchema.default('demo'),
  context: InterviewContextSchema.default({ resume: '', jobDescription: '', instructions: '' }),
});

export const InterviewIdParamsSchema = z.object({
  interviewId: IdSchema,
});

/**
 * Public representation of an interview. Context *contents* are intentionally
 * omitted (only character counts) so personal data is never echoed back.
 */
export const InterviewSummarySchema = z.object({
  id: IdSchema,
  mode: InterviewModeSchema,
  status: InterviewStatusSchema,
  activeSessionId: IdSchema.nullable(),
  sessionCount: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  context: z.object({
    resumeChars: z.number().int().nonnegative(),
    jobDescriptionChars: z.number().int().nonnegative(),
    instructionsChars: z.number().int().nonnegative(),
  }),
  stats: z.object({
    transcriptSegments: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
    answers: z.number().int().nonnegative(),
  }),
});

export const InterviewResponseSchema = z.object({ interview: InterviewSummarySchema });

const ModeCapabilitySchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  transcription: ProviderDescriptorSchema,
  llm: ProviderDescriptorSchema,
});

export const CapabilitiesSchema = z.object({
  protocolVersion: z.number().int(),
  modes: z.object({
    demo: ModeCapabilitySchema,
    live: ModeCapabilitySchema,
  }),
  audio: AudioFormatSchema.extend({ frameDurationMs: z.number().positive() }),
  detection: z.object({ silenceThresholdMs: z.number().int().positive() }),
  limits: z.object({
    resumeChars: z.number().int().positive(),
    jobDescriptionChars: z.number().int().positive(),
    instructionsChars: z.number().int().positive(),
    maxMessageBytes: z.number().int().positive(),
  }),
});
