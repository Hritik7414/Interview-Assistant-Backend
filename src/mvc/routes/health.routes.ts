import type { FastifyInstance } from 'fastify';
import { asyncHandler } from '../../utils/async-handler';
import type { HealthController } from '../controllers/health.controller';

export function registerHealthRoutes(app: FastifyInstance, controller: HealthController): void {
  // Probes are exempt from rate limiting.
  app.get(
    '/health',
    { config: { rateLimit: false } },
    asyncHandler(() => controller.liveness()),
  );
  app.get(
    '/health/ready',
    { config: { rateLimit: false } },
    asyncHandler(() => controller.readiness()),
  );
}
