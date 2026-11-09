import type { ServerEvent } from '@shared';
import WebSocket from 'ws';
import type { RealtimeClient } from '../mvc/controllers/controller.types';
import type { Logger } from '../utils/logger';
import { coalescePolicy, serializeServerEvent, WS_CLOSE_CODES } from './websocket.events';

export interface OutboundOptions {
  highWaterMarkBytes: number;
  maxQueuedEvents: number;
  flushIntervalMs: number;
}

/**
 * RealtimeClient backed by a `ws` socket with outbound backpressure.
 * While `bufferedAmount` exceeds the high-water mark, events are queued and
 * coalesced (interim transcripts replaced, answer deltas concatenated). A client
 * that cannot keep up is disconnected instead of letting memory grow unbounded.
 */
export class WebSocketClient implements RealtimeClient {
  isAlive = true;
  private queue: ServerEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly id: string,
    private readonly socket: WebSocket,
    private readonly options: OutboundOptions,
    private readonly logger: Logger,
  ) {}

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  get queuedEvents(): number {
    return this.queue.length;
  }

  send(event: ServerEvent): void {
    if (!this.isOpen) return;
    if (this.queue.length === 0 && this.socket.bufferedAmount <= this.options.highWaterMarkBytes) {
      this.write(event);
      return;
    }
    this.enqueue(event);
  }

  close(code: number, reason: string): void {
    this.dispose();
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(code, reason.slice(0, 120));
    }
  }

  ping(): void {
    if (this.isOpen) this.socket.ping();
  }

  terminate(): void {
    this.dispose();
    this.socket.terminate();
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.queue = [];
  }

  private enqueue(event: ServerEvent): void {
    const policy = coalescePolicy(event);
    if (policy === 'latest-wins') {
      this.queue = this.queue.filter((queued) => queued.type !== event.type);
    } else if (policy === 'concatenate' && event.type === 'answer.delta') {
      const last = this.queue.at(-1);
      if (last?.type === 'answer.delta' && last.payload.answerId === event.payload.answerId) {
        this.queue[this.queue.length - 1] = {
          ...last,
          payload: {
            ...last.payload,
            delta: last.payload.delta + event.payload.delta,
            index: event.payload.index,
          },
        };
        return;
      }
    }
    if (this.queue.length >= this.options.maxQueuedEvents) {
      this.logger.warn(
        { connectionId: this.id },
        'Outbound queue overflow; disconnecting slow client',
      );
      this.close(WS_CLOSE_CODES.TRY_AGAIN_LATER, 'Client is not keeping up');
      return;
    }
    this.queue.push(event);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.options.flushIntervalMs);
  }

  private flush(): void {
    while (
      this.queue.length > 0 &&
      this.isOpen &&
      this.socket.bufferedAmount <= this.options.highWaterMarkBytes
    ) {
      const next = this.queue.shift();
      if (next) this.write(next);
    }
    if (this.queue.length > 0 && this.isOpen) this.scheduleFlush();
  }

  private write(event: ServerEvent): void {
    try {
      this.socket.send(serializeServerEvent(event));
    } catch (error) {
      this.logger.warn({ err: error, connectionId: this.id }, 'Failed to send WebSocket message');
    }
  }
}
