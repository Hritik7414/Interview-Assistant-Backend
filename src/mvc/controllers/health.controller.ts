import type { ProviderCatalog } from '../../providers/provider.registry';
import type { InterviewSessionService } from '../../services/interview-session.service';
import type { HandlerResult } from '../../utils/async-handler';
import type { Clock } from '../../utils/runtime';

export class HealthController {
  constructor(
    private readonly deps: {
      providers: ProviderCatalog;
      sessions: InterviewSessionService;
      startedAt: number;
      now: Clock;
      isShuttingDown: () => boolean;
    },
  ) {}

  liveness(): HandlerResult<{ status: 'ok'; uptimeMs: number; activeSessions: number }> {
    return {
      status: 200,
      body: {
        status: 'ok',
        uptimeMs: this.deps.now() - this.deps.startedAt,
        activeSessions: this.deps.sessions.activeCount,
      },
    };
  }

  readiness() {
    const shuttingDown = this.deps.isShuttingDown();
    return {
      status: shuttingDown ? 503 : 200,
      body: {
        status: shuttingDown ? ('shutting_down' as const) : ('ready' as const),
        modes: {
          demo: this.deps.providers.availability('demo'),
          live: this.deps.providers.availability('live'),
        },
      },
    };
  }
}
