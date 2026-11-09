import type { z } from 'zod';
import type {
  AnswerSchema,
  AnswerStatusSchema,
  ApiErrorResponseSchema,
  AudioFormatSchema,
  AudioStatsSchema,
  CapabilitiesSchema,
  CreateInterviewRequestSchema,
  ErrorCodeSchema,
  FinishReasonSchema,
  InterviewContextPatchSchema,
  InterviewContextSchema,
  InterviewModeSchema,
  InterviewStatusSchema,
  InterviewSummarySchema,
  LatencyMetricNameSchema,
  LatencySnapshotSchema,
  LatencyStatsSchema,
  ProviderDescriptorSchema,
  QuestionSchema,
  QuestionStatusSchema,
  SessionStateSchema,
  TranscriptSegmentSchema,
} from '../schemas';

/** DTO types are always inferred from the Zod schemas, so runtime validation and types never drift. */
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export type InterviewMode = z.infer<typeof InterviewModeSchema>;
export type InterviewStatus = z.infer<typeof InterviewStatusSchema>;
export type InterviewContextDTO = z.output<typeof InterviewContextSchema>;
export type InterviewContextInput = z.input<typeof InterviewContextSchema>;
export type InterviewContextPatch = z.output<typeof InterviewContextPatchSchema>;
export type CreateInterviewRequest = z.input<typeof CreateInterviewRequestSchema>;
export type InterviewSummaryDTO = z.infer<typeof InterviewSummarySchema>;
export type CapabilitiesDTO = z.infer<typeof CapabilitiesSchema>;

export type ProviderDescriptor = z.infer<typeof ProviderDescriptorSchema>;
export type AudioFormat = z.infer<typeof AudioFormatSchema>;

export type TranscriptSegmentDTO = z.infer<typeof TranscriptSegmentSchema>;
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;
export type QuestionDTO = z.infer<typeof QuestionSchema>;
export type AnswerStatus = z.infer<typeof AnswerStatusSchema>;
export type FinishReason = z.infer<typeof FinishReasonSchema>;
export type AnswerDTO = z.infer<typeof AnswerSchema>;

export type LatencyMetricName = z.infer<typeof LatencyMetricNameSchema>;
export type LatencyStats = z.infer<typeof LatencyStatsSchema>;
export type LatencySnapshot = z.infer<typeof LatencySnapshotSchema>;

export type SessionState = z.infer<typeof SessionStateSchema>;
export type AudioStats = z.infer<typeof AudioStatsSchema>;
