import { z } from 'zod';

/** Describes which concrete provider serves a capability, and whether it is simulated. */
export const ProviderDescriptorSchema = z.object({
  name: z.string(),
  model: z.string().nullable(),
  simulated: z.boolean(),
});

export const AudioFormatSchema = z.object({
  encoding: z.literal('linear16'),
  sampleRate: z.number().int().min(8_000).max(48_000),
  channels: z.literal(1),
});
