import type { FastifyInstance } from 'fastify';
import type { HealthController } from '../controllers/health.controller';
import { registerHealthRoutes } from './health.routes';
import { registerInterviewRoutes, type InterviewRouteControllers } from './interview.routes';

export interface RouteControllers extends InterviewRouteControllers {
  health: HealthController;
}

export function registerRoutes(
  app: FastifyInstance,
  controllers: RouteControllers,
  options: { createPerMinute: number },
): void {
  registerHealthRoutes(app, controllers.health);
  registerInterviewRoutes(app, controllers, options);
}
