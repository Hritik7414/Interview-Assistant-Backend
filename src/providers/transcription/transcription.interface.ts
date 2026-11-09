import type { AudioFormat, ProviderDescriptor } from '@shared';

/** Provider-neutral transcription result. Times are ms offsets within the provider stream. */
export interface TranscriptionResult {
  text: string;
  isFinal: boolean;
  /** Provider detected the end of a spoken phrase (endpointing). */
  speechFinal: boolean;
  startMs: number;
  endMs: number;
  confidence: number;
}

export interface TranscriptionStreamHandlers {
  onResult(result: TranscriptionResult): void;
  /** Provider detected a gap in speech after the last word. */
  onUtteranceEnd(info: { lastWordEndMs: number | null }): void;
  onSpeechStarted?(): void;
  onError(error: Error, info: { fatal: boolean }): void;
  /** `expected` is true when the close was requested by us. */
  onClose(info: { code: number; reason: string; expected: boolean }): void;
}

export interface TranscriptionStream {
  write(pcm: Uint8Array): void;
  /** Flushes pending audio, waits for final results, then releases the connection. */
  close(): Promise<void>;
}

export interface TranscriptionStreamOptions {
  sessionId: string;
  format: AudioFormat;
}

/** Contract every speech-to-text vendor adapter implements. */
export interface TranscriptionProvider {
  readonly descriptor: ProviderDescriptor;
  /** Resolves once the stream is ready to accept audio. */
  open(
    options: TranscriptionStreamOptions,
    handlers: TranscriptionStreamHandlers,
  ): Promise<TranscriptionStream>;
}
