import type { RealtimeContext } from '../mvc/controllers/controller.types';
import type { TokenBucket } from '../middleware/rate-limit.middleware';
import type { InterviewSessionService } from '../services/interview-session.service';
import { runDetached } from '../utils/async-handler';
import type { Logger } from '../utils/logger';
import type { WebSocketClient } from './websocket.client';
import { CLOSE_SESSION_TAKEN_OVER, WS_CLOSE_CODES } from './websocket.events';

/** Per-connection transport state. */
export interface ConnectionContext extends RealtimeContext {
  readonly id: string;
  readonly client: WebSocketClient;
  readonly remoteAddress: string;
  readonly bucket: TokenBucket;
  sessionId: string | null;
  startPending: boolean;
  closed: boolean;
  violations: number;
  /** Last time an error of a given code was reported (throttles error spam). */
  lastErrorAt: Map<string, number>;
}

/**
 * Tracks live connections and their session bindings. Unexpected disconnects
 * suspend the session for a grace period so the client can reconnect and
 * resume; clean closes stop the session immediately.
 */
export class WebSocketSessionManager {
  private readonly connections = new Map<string, ConnectionContext>();
  private readonly perIp = new Map<string, number>();
  private readonly owners = new Map<string, ConnectionContext>();
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly deps: {
      sessions: InterviewSessionService;
      config: { maxConnectionsPerIp: number; resumeGraceMs: number };
      logger: Logger;
    },
  ) {}

  get connectionCount(): number {
    return this.connections.size;
  }

  canAccept(remoteAddress: string): boolean {
    return (this.perIp.get(remoteAddress) ?? 0) < this.deps.config.maxConnectionsPerIp;
  }

  add(context: ConnectionContext): void {
    this.connections.set(context.id, context);
    this.perIp.set(context.remoteAddress, (this.perIp.get(context.remoteAddress) ?? 0) + 1);
  }

  forEach(callback: (context: ConnectionContext) => void): void {
    this.connections.forEach(callback);
  }

  /** Binds a started/resumed session to a connection, taking it over from any stale owner. */
  async bindSession(context: ConnectionContext, sessionId: string): Promise<void> {
    if (context.closed) {
      // The client vanished while the session was starting: don't leak it.
      await this.deps.sessions.stop(sessionId, 'client_disconnected');
      return;
    }
    this.clearGraceTimer(sessionId);
    const previous = this.owners.get(sessionId);
    if (previous && previous !== context) {
      previous.sessionId = null;
      previous.client.close(CLOSE_SESSION_TAKEN_OVER, 'Session resumed on another connection');
    }
    context.sessionId = sessionId;
    this.owners.set(sessionId, context);
  }

  unbindSession(context: ConnectionContext): void {
    if (context.sessionId && this.owners.get(context.sessionId) === context) {
      this.owners.delete(context.sessionId);
    }
    context.sessionId = null;
  }

  async remove(context: ConnectionContext, closeCode: number): Promise<void> {
    if (!this.connections.delete(context.id)) return;
    context.closed = true;
    context.client.dispose();
    const remaining = (this.perIp.get(context.remoteAddress) ?? 1) - 1;
    if (remaining <= 0) this.perIp.delete(context.remoteAddress);
    else this.perIp.set(context.remoteAddress, remaining);

    const sessionId = context.sessionId;
    if (!sessionId || this.owners.get(sessionId) !== context) return;
    this.owners.delete(sessionId);

    if (closeCode === WS_CLOSE_CODES.NORMAL || this.deps.config.resumeGraceMs === 0) {
      await this.deps.sessions.stop(sessionId, 'client_disconnected');
      return;
    }
    this.deps.sessions.suspend(sessionId);
    const timer = setTimeout(() => {
      this.graceTimers.delete(sessionId);
      runDetached(
        () => this.deps.sessions.stop(sessionId, 'resume_timeout'),
        (error) =>
          this.deps.logger.error({ err: error, sessionId }, 'Failed to stop expired session'),
      );
    }, this.deps.config.resumeGraceMs);
    timer.unref();
    this.graceTimers.set(sessionId, timer);
  }

  async shutdown(): Promise<void> {
    this.graceTimers.forEach((timer) => clearTimeout(timer));
    this.graceTimers.clear();
    this.connections.forEach((context) =>
      context.client.close(WS_CLOSE_CODES.GOING_AWAY, 'Server shutting down'),
    );
  }

  private clearGraceTimer(sessionId: string): void {
    const timer = this.graceTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.graceTimers.delete(sessionId);
  }
}
