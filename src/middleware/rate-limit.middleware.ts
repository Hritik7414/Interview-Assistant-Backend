import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { RateLimitError } from '../utils/errors';
import type { Clock } from '../utils/runtime';

/** HTTP rate limiting (per client IP). Individual routes may tighten or disable it. */
export async function registerRateLimiting(
  app: FastifyInstance,
  options: { maxPerMinute: number },
): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: options.maxPerMinute,
    timeWindow: 60_000,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_request, context) =>
      new RateLimitError(`Rate limit exceeded; retry in ${context.after}`),
  });
}

/**
 * Token bucket used to rate-limit inbound WebSocket messages per connection.
 * Audio arrives at a steady 20 frames/s, so the bucket allows that plus control
 * traffic and short bursts, but stops floods.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: Clock = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  tryRemove(count = 1): boolean {
    this.refill();
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  private refill(): void {
    const current = this.now();
    const elapsedSeconds = (current - this.lastRefill) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = current;
  }
}
