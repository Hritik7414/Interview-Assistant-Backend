import {
  encodeAudioFrame,
  ServerEventSchema,
  type ServerEvent,
  type ServerEventOf,
  type ServerEventType,
} from '@shared';
import WebSocket from 'ws';

interface Waiter {
  match: (event: ServerEvent) => boolean;
  resolve: (event: ServerEvent) => void;
}

/** WebSocket client for integration tests. Every server event is schema-validated. */
export class TestWsClient {
  readonly events: ServerEvent[] = [];
  readonly invalidEvents: unknown[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: Waiter[] = [];
  private seq = 0;

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const json: unknown = JSON.parse(data.toString());
      const parsed = ServerEventSchema.safeParse(json);
      if (!parsed.success) {
        this.invalidEvents.push(json);
        return;
      }
      this.events.push(parsed.data);
      this.waiters = this.waiters.filter((waiter) => {
        if (!waiter.match(parsed.data)) return true;
        waiter.resolve(parsed.data);
        return false;
      });
    });
    this.closed = new Promise((resolve) => {
      socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }

  static connect(url: string, origin = 'http://localhost:3000'): Promise<TestWsClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { origin });
      socket.once('open', () => resolve(new TestWsClient(socket)));
      socket.once('error', reject);
      socket.once('unexpected-response', (_req, res) =>
        reject(new Error(`HTTP ${res.statusCode}`)),
      );
    });
  }

  send(event: unknown): void {
    this.socket.send(JSON.stringify(event));
  }

  sendRaw(data: string | Buffer): void {
    this.socket.send(data);
  }

  /** Sends `ms` of silent PCM16 audio as a single binary frame. */
  sendAudio(ms: number, capturedAt = Date.now()): void {
    const samples = new Int16Array(Math.round((16_000 * ms) / 1000));
    this.socket.send(Buffer.from(encodeAudioFrame({ seq: this.seq++, capturedAt, pcm: samples })));
  }

  /** Streams `totalMs` of audio in `frameMs` chunks. */
  streamAudio(totalMs: number, frameMs = 500): void {
    for (let sent = 0; sent < totalMs; sent += frameMs)
      this.sendAudio(Math.min(frameMs, totalMs - sent));
  }

  ofType<T extends ServerEventType>(type: T): ServerEventOf<T>[] {
    return this.events.filter((event): event is ServerEventOf<T> => event.type === type);
  }

  /** Resolves with the first (already received or future) event matching type + predicate. */
  waitFor<T extends ServerEventType>(
    type: T,
    predicate: (event: ServerEventOf<T>) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<ServerEventOf<T>> {
    const match = (event: ServerEvent): boolean =>
      event.type === type && predicate(event as ServerEventOf<T>);
    const existing = this.events.find(match);
    if (existing) return Promise.resolve(existing as ServerEventOf<T>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.resolve !== done);
        reject(
          new Error(
            `Timed out waiting for ${type}; received: ${this.events.map((e) => e.type).join(', ')}`,
          ),
        );
      }, timeoutMs);
      const done = (event: ServerEvent) => {
        clearTimeout(timer);
        resolve(event as ServerEventOf<T>);
      };
      this.waiters.push({ match, resolve: done });
    });
  }

  async waitForCount<T extends ServerEventType>(
    type: T,
    count: number,
    timeoutMs = 5_000,
  ): Promise<ServerEventOf<T>[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.ofType(type).length < count) {
      if (Date.now() > deadline)
        throw new Error(`Expected ${count} ${type} events, got ${this.ofType(type).length}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.ofType(type);
  }

  close(code = 1000): Promise<{ code: number; reason: string }> {
    this.socket.close(code);
    return this.closed;
  }

  terminate(): void {
    this.socket.terminate();
  }
}
