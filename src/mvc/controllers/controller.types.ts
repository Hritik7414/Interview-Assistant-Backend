import type { ServerEvent } from '@shared';

/**
 * Port through which controllers push events to one realtime client.
 * Implemented by the WebSocket layer; controllers never touch sockets directly.
 */
export interface RealtimeClient {
  readonly id: string;
  send(event: ServerEvent): void;
  close(code: number, reason: string): void;
}

/** What a realtime controller knows about the connection that sent a message. */
export interface RealtimeContext {
  readonly client: RealtimeClient;
  readonly sessionId: string | null;
}
