import { z } from 'zod';

/**
 * Server-side session lifecycle.
 * idle → starting → listening ⇄ thinking → answering → listening … → stopped
 * `suspended` = transport dropped; the session waits for a resume within the grace period.
 */
export const SessionStateSchema = z.enum([
  'idle',
  'starting',
  'listening',
  'thinking',
  'answering',
  'suspended',
  'stopped',
]);

export const AudioStatsSchema = z.object({
  framesReceived: z.number().int().nonnegative(),
  framesDropped: z.number().int().nonnegative(),
  bytesReceived: z.number().int().nonnegative(),
  audioMs: z.number().nonnegative(),
});
