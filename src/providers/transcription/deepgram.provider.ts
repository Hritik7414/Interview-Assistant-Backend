import type { ProviderDescriptor } from '@shared';
import WebSocket from 'ws';
import { z } from 'zod';
import type { DeepgramConfig } from '../../config/ai.config';
import { ProviderError } from '../../utils/errors';
import type { Logger } from '../../utils/logger';
import type {
  TranscriptionProvider,
  TranscriptionStream,
  TranscriptionStreamHandlers,
  TranscriptionStreamOptions,
} from './transcription.interface';

const PROVIDER = 'deepgram';

/** Subset of Deepgram's live streaming messages we rely on (validated — external input). */
const DeepgramMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('Results'),
    start: z.number().default(0),
    duration: z.number().default(0),
    is_final: z.boolean().default(false),
    speech_final: z.boolean().default(false),
    channel: z.object({
      alternatives: z
        .array(z.object({ transcript: z.string().default(''), confidence: z.number().default(0) }))
        .default([]),
    }),
  }),
  z.object({ type: z.literal('UtteranceEnd'), last_word_end: z.number().optional() }),
  z.object({ type: z.literal('SpeechStarted') }),
  z.object({ type: z.literal('Metadata'), request_id: z.string().optional() }),
  z.object({
    type: z.literal('Error'),
    description: z.string().optional(),
    message: z.string().optional(),
  }),
]);

/**
 * Deepgram live STT over its documented WebSocket protocol
 * (wss://api.deepgram.com/v1/listen). Using `ws` directly keeps the adapter
 * small, dependency-light and testable against a local fake server.
 */
export class DeepgramTranscriptionProvider implements TranscriptionProvider {
  readonly descriptor: ProviderDescriptor;

  constructor(
    private readonly config: DeepgramConfig & { apiKey: string },
    private readonly logger: Logger,
  ) {
    this.descriptor = { name: PROVIDER, model: config.model, simulated: false };
  }

  buildUrl(options: TranscriptionStreamOptions): string {
    const params = new URLSearchParams({
      model: this.config.model,
      language: this.config.language,
      encoding: options.format.encoding,
      sample_rate: String(options.format.sampleRate),
      channels: String(options.format.channels),
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      endpointing: String(this.config.endpointingMs),
      utterance_end_ms: String(this.config.utteranceEndMs),
      vad_events: 'true',
    });
    return `${this.config.baseUrl}?${params.toString()}`;
  }

  open(
    options: TranscriptionStreamOptions,
    handlers: TranscriptionStreamHandlers,
  ): Promise<TranscriptionStream> {
    const socket = new WebSocket(this.buildUrl(options), {
      headers: { Authorization: `Token ${this.config.apiKey}` },
      handshakeTimeout: this.config.connectTimeoutMs,
      perMessageDeflate: false,
    });

    return new Promise<TranscriptionStream>((resolve, reject) => {
      let settled = false;
      const fail = (error: ProviderError) => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        socket.on('error', () => undefined);
        socket.terminate();
        reject(error);
      };

      socket.once('open', () => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners('unexpected-response');
        resolve(
          new DeepgramStream(
            socket,
            handlers,
            this.config,
            this.logger.child({ sessionId: options.sessionId }),
          ),
        );
      });
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        fail(
          new ProviderError(
            'TRANSCRIPTION_PROVIDER_ERROR',
            PROVIDER,
            describeHandshakeFailure(response.statusCode ?? 0),
            { recoverable: false },
          ),
        );
      });
      socket.once('error', (error) => {
        fail(
          new ProviderError(
            'TRANSCRIPTION_PROVIDER_ERROR',
            PROVIDER,
            `Could not connect to Deepgram: ${error.message}`,
            { cause: error },
          ),
        );
      });
    });
  }
}

class DeepgramStream implements TranscriptionStream {
  private lastSentAt = Date.now();
  private closing = false;
  private readonly keepAliveTimer: NodeJS.Timeout;
  private readonly closed: Promise<void>;

  constructor(
    private readonly socket: WebSocket,
    private readonly handlers: TranscriptionStreamHandlers,
    private readonly config: DeepgramConfig,
    private readonly logger: Logger,
  ) {
    this.closed = new Promise<void>((resolve) => {
      socket.on('close', (code, reason) => {
        clearInterval(this.keepAliveTimer);
        this.handlers.onClose({
          code,
          reason: reason.toString(),
          expected: this.closing || code === 1000,
        });
        resolve();
      });
    });
    socket.on('message', (data, isBinary) => {
      if (!isBinary) this.handleMessage(data.toString());
    });
    socket.on('error', (error) => {
      this.handlers.onError(
        new ProviderError(
          'TRANSCRIPTION_PROVIDER_ERROR',
          PROVIDER,
          `Deepgram stream error: ${error.message}`,
          { cause: error },
        ),
        { fatal: false },
      );
    });
    // Deepgram closes idle streams after ~10 s without audio; KeepAlive prevents that
    // during silence or while a session is suspended.
    this.keepAliveTimer = setInterval(() => this.sendKeepAlive(), config.keepAliveIntervalMs);
    this.keepAliveTimer.unref();
  }

  write(pcm: Uint8Array): void {
    if (this.closing || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(pcm);
    this.lastSentAt = Date.now();
  }

  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      if (this.socket.readyState === WebSocket.OPEN) {
        // Ask Deepgram to flush remaining results, then close gracefully.
        this.socket.send(JSON.stringify({ type: 'CloseStream' }));
      }
      const timer = setTimeout(() => this.socket.terminate(), this.config.closeTimeoutMs);
      timer.unref();
      void this.closed.finally(() => clearTimeout(timer));
    }
    return this.closed;
  }

  private sendKeepAlive(): void {
    if (this.closing || this.socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastSentAt < this.config.keepAliveIntervalMs) return;
    this.socket.send(JSON.stringify({ type: 'KeepAlive' }));
  }

  private handleMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.logger.warn('Ignoring non-JSON Deepgram message');
      return;
    }
    const parsed = DeepgramMessageSchema.safeParse(json);
    if (!parsed.success) return; // Unknown/irrelevant message types are ignored.
    const message = parsed.data;

    switch (message.type) {
      case 'Results': {
        const alternative = message.channel.alternatives[0];
        if (!alternative) return;
        this.handlers.onResult({
          text: alternative.transcript,
          isFinal: message.is_final,
          speechFinal: message.speech_final,
          startMs: message.start * 1000,
          endMs: (message.start + message.duration) * 1000,
          confidence: alternative.confidence,
        });
        return;
      }
      case 'UtteranceEnd':
        this.handlers.onUtteranceEnd({
          lastWordEndMs: message.last_word_end === undefined ? null : message.last_word_end * 1000,
        });
        return;
      case 'SpeechStarted':
        this.handlers.onSpeechStarted?.();
        return;
      case 'Metadata':
        this.logger.debug({ requestId: message.request_id }, 'Deepgram stream metadata');
        return;
      case 'Error':
        this.handlers.onError(
          new ProviderError(
            'TRANSCRIPTION_PROVIDER_ERROR',
            PROVIDER,
            message.description ?? message.message ?? 'Deepgram reported an error',
          ),
          { fatal: false },
        );
        return;
    }
  }
}

function describeHandshakeFailure(status: number): string {
  if (status === 401 || status === 403)
    return 'Deepgram rejected the API key (check DEEPGRAM_API_KEY)';
  if (status === 402) return 'Deepgram account has insufficient credits';
  if (status === 429) return 'Deepgram rate limit exceeded';
  if (status === 400) return 'Deepgram rejected the stream parameters';
  return `Deepgram handshake failed with HTTP ${status}`;
}
