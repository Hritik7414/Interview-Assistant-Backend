import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { DeepgramTranscriptionProvider } from '../../../src/providers/transcription/deepgram.provider';
import type { TranscriptionStreamHandlers } from '../../../src/providers/transcription/transcription.interface';
import { ProviderError } from '../../../src/utils/errors';
import { createSilentLogger } from '../../../src/utils/logger';
import { pcm } from '../../helpers/fakes';

interface FakeDeepgram {
  url: string;
  server: WebSocketServer;
  connection: Promise<{ socket: WebSocket; request: IncomingMessage }>;
  received: Array<Buffer | string>;
}

async function startFakeDeepgram(options: { reject?: number } = {}): Promise<FakeDeepgram> {
  const received: Array<Buffer | string> = [];
  const server = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    ...(options.reject
      ? {
          verifyClient: (_info: unknown, done: (ok: boolean, code?: number) => void) =>
            done(false, options.reject),
        }
      : {}),
  });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const connection = new Promise<{ socket: WebSocket; request: IncomingMessage }>((resolve) => {
    server.on('connection', (socket, request) => {
      socket.on('message', (data, isBinary) => {
        received.push(isBinary ? (data as Buffer) : data.toString());
        if (!isBinary && data.toString().includes('CloseStream')) socket.close(1000, 'done');
      });
      resolve({ socket, request });
    });
  });
  const { port } = server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}/v1/listen`, server, connection, received };
}

function createProvider(baseUrl: string) {
  return new DeepgramTranscriptionProvider(
    {
      apiKey: 'test-key',
      model: 'nova-3',
      language: 'en-US',
      baseUrl,
      endpointingMs: 300,
      utteranceEndMs: 1_000,
      keepAliveIntervalMs: 40,
      connectTimeoutMs: 2_000,
      closeTimeoutMs: 500,
    },
    createSilentLogger(),
  );
}

function createHandlers(): TranscriptionStreamHandlers & Record<string, ReturnType<typeof vi.fn>> {
  return {
    onResult: vi.fn(),
    onUtteranceEnd: vi.fn(),
    onSpeechStarted: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
}

const FORMAT = { encoding: 'linear16', sampleRate: 16_000, channels: 1 } as const;

describe('DeepgramTranscriptionProvider', () => {
  let fake: FakeDeepgram | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (fake ? fake.server.close(() => resolve()) : resolve()));
    fake = undefined;
  });

  it('authenticates with the API key and requests streaming parameters', async () => {
    fake = await startFakeDeepgram();
    const stream = await createProvider(fake.url).open(
      { sessionId: 's', format: FORMAT },
      createHandlers(),
    );
    const { request } = await fake.connection;
    expect(request.headers.authorization).toBe('Token test-key');
    const params = new URL(request.url ?? '', 'ws://x').searchParams;
    expect(Object.fromEntries(params)).toMatchObject({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      utterance_end_ms: '1000',
      endpointing: '300',
      vad_events: 'true',
    });
    await stream.close();
  });

  it('forwards audio and maps Results / UtteranceEnd messages', async () => {
    fake = await startFakeDeepgram();
    const handlers = createHandlers();
    const stream = await createProvider(fake.url).open(
      { sessionId: 's', format: FORMAT },
      handlers,
    );
    const { socket } = await fake.connection;

    stream.write(pcm(100));
    await vi.waitFor(() => expect(fake!.received.some((m) => Buffer.isBuffer(m))).toBe(true));

    socket.send(
      JSON.stringify({
        type: 'Results',
        start: 1.5,
        duration: 0.75,
        is_final: true,
        speech_final: true,
        channel: { alternatives: [{ transcript: 'How are you?', confidence: 0.93 }] },
      }),
    );
    socket.send(JSON.stringify({ type: 'UtteranceEnd', last_word_end: 2.2 }));
    socket.send(JSON.stringify({ type: 'Unknown', foo: 1 }));
    socket.send('not json');

    await vi.waitFor(() => expect(handlers.onUtteranceEnd).toHaveBeenCalled());
    expect(handlers.onResult).toHaveBeenCalledWith({
      text: 'How are you?',
      isFinal: true,
      speechFinal: true,
      startMs: 1_500,
      endMs: 2_250,
      confidence: 0.93,
    });
    expect(handlers.onUtteranceEnd).toHaveBeenCalledWith({ lastWordEndMs: 2_200 });
    await stream.close();
  });

  it('sends KeepAlive while idle and CloseStream on graceful close', async () => {
    fake = await startFakeDeepgram();
    const handlers = createHandlers();
    const stream = await createProvider(fake.url).open(
      { sessionId: 's', format: FORMAT },
      handlers,
    );
    await fake.connection;
    await vi.waitFor(() => expect(fake!.received).toContain('{"type":"KeepAlive"}'), {
      timeout: 2_000,
    });

    await stream.close();
    expect(fake.received).toContain('{"type":"CloseStream"}');
    expect(handlers.onClose).toHaveBeenCalledWith(
      expect.objectContaining({ code: 1000, expected: true }),
    );
  });

  it('reports unexpected disconnects as not expected', async () => {
    fake = await startFakeDeepgram();
    const handlers = createHandlers();
    await createProvider(fake.url).open({ sessionId: 's', format: FORMAT }, handlers);
    const { socket } = await fake.connection;
    socket.close(1011, 'NET-0001');
    await vi.waitFor(() => expect(handlers.onClose).toHaveBeenCalled());
    expect(handlers.onClose).toHaveBeenCalledWith({
      code: 1011,
      reason: 'NET-0001',
      expected: false,
    });
  });

  it('rejects with a clear ProviderError when the API key is refused', async () => {
    fake = await startFakeDeepgram({ reject: 401 });
    const opening = createProvider(fake.url).open(
      { sessionId: 's', format: FORMAT },
      createHandlers(),
    );
    await expect(opening).rejects.toBeInstanceOf(ProviderError);
    await expect(opening).rejects.toThrow(/rejected the API key/);
  });

  it('rejects when the endpoint is unreachable', async () => {
    const provider = createProvider('ws://127.0.0.1:1/v1/listen');
    await expect(
      provider.open({ sessionId: 's', format: FORMAT }, createHandlers()),
    ).rejects.toThrow(/Could not connect to Deepgram/);
  });
});
