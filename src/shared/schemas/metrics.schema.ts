import { z } from 'zod';

export const LatencyMetricNameSchema = z.enum([
  'audioIngestion',
  'transcription',
  'questionDetection',
  'llmFirstToken',
  'answerTotal',
  'endToEnd',
]);

export const LATENCY_METRIC_NAMES = LatencyMetricNameSchema.options;

export const LatencyStatsSchema = z.object({
  count: z.number().int().nonnegative(),
  last: z.number(),
  avg: z.number(),
  p50: z.number(),
  p95: z.number(),
  min: z.number(),
  max: z.number(),
});

/** One entry per metric; `null` until the first sample is recorded. */
export const LatencySnapshotSchema = z.object({
  audioIngestion: LatencyStatsSchema.nullable(),
  transcription: LatencyStatsSchema.nullable(),
  questionDetection: LatencyStatsSchema.nullable(),
  llmFirstToken: LatencyStatsSchema.nullable(),
  answerTotal: LatencyStatsSchema.nullable(),
  endToEnd: LatencyStatsSchema.nullable(),
});

export const MetricsResponseSchema = z.object({
  metrics: LatencySnapshotSchema,
});
