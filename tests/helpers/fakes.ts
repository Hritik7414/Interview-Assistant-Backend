import type { ProviderDescriptor } from '@shared';
import type {
  LlmCompletionRequest,
  LlmProvider,
  LlmStreamEvent,
} from '../../src/providers/llm/llm.interface';
import type {
  TranscriptionProvider,
  TranscriptionResult,
  TranscriptionStream,
  TranscriptionStreamHandlers,
  TranscriptionStreamOptions,
} from '../../src/providers/transcription/transcription.interface';
import { abortableDelay } from '../../src/utils/runtime';

/** Manually driven STT stream: tests decide exactly which results arrive and when. */
export class FakeTranscriptionStream implements TranscriptionStream {
  readonly written: Uint8Array[] = [];
  closed = false;

  constructor(
    readonly options: TranscriptionStreamOptions,
    readonly handlers: TranscriptionStreamHandlers,
  ) {}

  write(pcm: Uint8Array): void {
    this.written.push(pcm);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose({ code: 1000, reason: 'closed', expected: true });
  }

  emit(result: Partial<TranscriptionResult> & { text: string }): void {
    this.handlers.onResult({
      isFinal: false,
      speechFinal: false,
      startMs: 0,
      endMs: 0,
      confidence: 0.9,
      ...result,
    });
  }

  emitFinal(text: string, startMs: number, endMs: number, speechFinal = false): void {
    this.emit({ text, startMs, endMs, isFinal: true, speechFinal });
  }

  utteranceEnd(): void {
    this.handlers.onUtteranceEnd({ lastWordEndMs: null });
  }

  drop(): void {
    this.handlers.onClose({ code: 1011, reason: 'provider went away', expected: false });
  }
}

export class FakeTranscriptionProvider implements TranscriptionProvider {
  readonly descriptor: ProviderDescriptor = { name: 'fake-stt', model: null, simulated: true };
  readonly streams: FakeTranscriptionStream[] = [];
  /** Errors thrown by the next `open` calls, in order. */
  openErrors: Error[] = [];

  async open(
    options: TranscriptionStreamOptions,
    handlers: TranscriptionStreamHandlers,
  ): Promise<TranscriptionStream> {
    const error = this.openErrors.shift();
    if (error) throw error;
    const stream = new FakeTranscriptionStream(options, handlers);
    this.streams.push(stream);
    return stream;
  }

  get last(): FakeTranscriptionStream {
    const stream = this.streams.at(-1);
    if (!stream) throw new Error('No stream opened yet');
    return stream;
  }
}

export interface ScriptedLlmOptions {
  tokens?: string[];
  delayMs?: number;
  failWith?: Error;
  /** Never finishes on its own (until aborted). */
  hang?: boolean;
  finishReason?: 'stop' | 'length';
}

export class ScriptedLlmProvider implements LlmProvider {
  readonly descriptor: ProviderDescriptor = {
    name: 'scripted-llm',
    model: 'test-model',
    simulated: true,
  };
  readonly requests: LlmCompletionRequest[] = [];

  constructor(private readonly options: ScriptedLlmOptions = {}) {}

  async *stream(request: LlmCompletionRequest): AsyncIterable<LlmStreamEvent> {
    this.requests.push(request);
    const tokens = this.options.tokens ?? ['- First ', 'point.\n', '- Second ', 'point.'];
    for (const token of tokens) {
      await abortableDelay(this.options.delayMs ?? 1, request.signal);
      if (this.options.failWith) throw this.options.failWith;
      yield { type: 'delta', text: token };
    }
    if (this.options.hang) await abortableDelay(60_000, request.signal);
    yield { type: 'done', finishReason: this.options.finishReason ?? 'stop' };
  }
}

export function pcm(ms: number, sampleRate = 16_000): Uint8Array {
  return new Uint8Array(Math.round((sampleRate * ms) / 1000) * 2);
}
