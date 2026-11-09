import { pcmBytesToMs, type AudioFormat } from '@shared';
import { isDuplicateSegment, TranscriptSegment } from '../mvc/models/transcript.model';
import type {
  TranscriptionProvider,
  TranscriptionResult,
  TranscriptionStream,
  TranscriptionStreamHandlers,
} from '../providers/transcription/transcription.interface';
import type { TranscriptRepository } from '../repositories/transcript.repository';
import { type AppError, ProviderError, toAppError } from '../utils/errors';
import type { Logger } from '../utils/logger';
import { abortableDelay, type Clock, type IdGenerator } from '../utils/runtime';
import { runDetached } from '../utils/async-handler';
import type { LatencyMetricsService } from './latency-metrics.service';

export interface TranscriptionSessionHandlers {
  onPartial(segment: TranscriptSegment): void;
  onFinal(segment: TranscriptSegment): void;
  onUtteranceEnd(info: { receivedAt: number }): void;
  onSpeechStarted(): void;
  /** `fatal` means transcription has stopped for good and the session should end. */
  onError(error: AppError, info: { fatal: boolean }): void;
}

export interface OpenTranscriptionParams {
  sessionId: string;
  interviewId: string;
  provider: TranscriptionProvider;
  format: AudioFormat;
  handlers: TranscriptionSessionHandlers;
}

export interface TranscriptionServiceConfig {
  maxPendingChunks: number;
  maxReconnectAttempts: number;
  reconnectBaseDelayMs: number;
}

/**
 * Maps audio-time offsets to the wall-clock moment that audio was forwarded,
 * so transcription latency = result arrival − send time of the covered audio.
 */
class AudioTimeline {
  private readonly entries: Array<{ endMs: number; at: number }> = [];
  totalMs = 0;

  constructor(private readonly capacity = 1_200) {}

  push(durationMs: number, at: number): void {
    this.totalMs += durationMs;
    this.entries.push({ endMs: this.totalMs, at });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  sentAtFor(audioMs: number): number | null {
    let low = 0;
    let high = this.entries.length - 1;
    let match: number | null = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const entry = this.entries[mid];
      if (!entry) break;
      if (entry.endMs >= audioMs - 0.5) {
        match = entry.at;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return match;
  }
}

interface ActiveTranscription {
  params: OpenTranscriptionParams;
  stream: TranscriptionStream | null;
  timeline: AudioTimeline;
  /** Audio offset of the current provider stream (non-zero after a reconnect). */
  offsetMs: number;
  partialId: string;
  lastPartialText: string;
  pending: Uint8Array[];
  closing: boolean;
  reconnecting: boolean;
}

/**
 * Owns provider streams per session: forwards audio, normalises results into
 * TranscriptSegments, prevents duplicates, persists finals, measures latency
 * and transparently reconnects after unexpected provider disconnects.
 */
export class TranscriptionService {
  private readonly active = new Map<string, ActiveTranscription>();

  constructor(
    private readonly deps: {
      transcripts: TranscriptRepository;
      metrics: LatencyMetricsService;
      config: TranscriptionServiceConfig;
      logger: Logger;
      ids: IdGenerator;
      now: Clock;
    },
  ) {}

  async open(params: OpenTranscriptionParams): Promise<void> {
    if (this.active.has(params.sessionId)) return;
    const state: ActiveTranscription = {
      params,
      stream: null,
      timeline: new AudioTimeline(),
      offsetMs: 0,
      partialId: this.deps.ids(),
      lastPartialText: '',
      pending: [],
      closing: false,
      reconnecting: false,
    };
    this.active.set(params.sessionId, state);
    try {
      state.stream = await params.provider.open(
        { sessionId: params.sessionId, format: params.format },
        this.createHandlers(state),
      );
      this.flushPending(state);
    } catch (error) {
      this.active.delete(params.sessionId);
      throw toAppError(error);
    }
  }

  /** Forwards audio to the provider. Returns false when the chunk had to be dropped. */
  write(sessionId: string, pcm: Uint8Array): boolean {
    const state = this.active.get(sessionId);
    if (!state || state.closing) return false;
    const durationMs = pcmBytesToMs(pcm.byteLength, state.params.format.sampleRate);
    if (!state.stream) {
      // Provider is (re)connecting: keep a bounded backlog, dropping the oldest audio.
      state.pending.push(pcm);
      if (state.pending.length > this.deps.config.maxPendingChunks) {
        state.pending.shift();
        return false;
      }
      return true;
    }
    state.timeline.push(durationMs, this.deps.now());
    state.stream.write(pcm);
    return true;
  }

  async close(sessionId: string): Promise<void> {
    const state = this.active.get(sessionId);
    if (!state) return;
    state.closing = true;
    try {
      await state.stream?.close();
    } catch (error) {
      this.deps.logger.warn({ err: error, sessionId }, 'Error while closing transcription stream');
    } finally {
      this.active.delete(sessionId);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((sessionId) => this.close(sessionId)));
  }

  getTranscript(interviewId: string): readonly TranscriptSegment[] {
    return this.deps.transcripts.listByInterview(interviewId);
  }

  recentSegments(interviewId: string, limit: number): TranscriptSegment[] {
    return this.deps.transcripts.recent(interviewId, limit);
  }

  private createHandlers(state: ActiveTranscription): TranscriptionStreamHandlers {
    return {
      onResult: (result) => this.handleResult(state, result),
      onUtteranceEnd: () => state.params.handlers.onUtteranceEnd({ receivedAt: this.deps.now() }),
      onSpeechStarted: () => state.params.handlers.onSpeechStarted(),
      onError: (error, info) => {
        this.deps.logger.warn(
          { err: error, sessionId: state.params.sessionId },
          'Transcription provider error',
        );
        if (!info.fatal) state.params.handlers.onError(toAppError(error), { fatal: false });
      },
      onClose: (info) => {
        if (info.expected || state.closing) return;
        this.deps.logger.warn(
          { sessionId: state.params.sessionId, code: info.code, reason: info.reason },
          'Transcription stream closed unexpectedly; reconnecting',
        );
        runDetached(
          () => this.reconnect(state),
          (error) => this.deps.logger.error({ err: error }, 'Transcription reconnect crashed'),
        );
      },
    };
  }

  private handleResult(state: ActiveTranscription, result: TranscriptionResult): void {
    if (state.closing && !result.isFinal) return;
    const { sessionId, interviewId } = state.params;
    const text = result.text.trim();
    const receivedAt = this.deps.now();
    const startMs = result.startMs + state.offsetMs;
    const endMs = result.endMs + state.offsetMs;

    if (!result.isFinal) {
      if (text === '' || text === state.lastPartialText) return;
      state.lastPartialText = text;
      this.recordLatency(state, endMs, receivedAt);
      state.params.handlers.onPartial(
        TranscriptSegment.create({
          id: state.partialId,
          interviewId,
          sessionId,
          text,
          isFinal: false,
          startMs,
          endMs,
          confidence: result.confidence,
          speechFinal: false,
          receivedAt,
        }),
      );
      return;
    }

    const id = state.partialId;
    state.partialId = this.deps.ids();
    state.lastPartialText = '';
    if (text === '') return; // Providers emit empty finals for silence.

    const segment = TranscriptSegment.create({
      id,
      interviewId,
      sessionId,
      text,
      isFinal: true,
      startMs,
      endMs,
      confidence: result.confidence,
      speechFinal: result.speechFinal,
      receivedAt,
    });
    if (isDuplicateSegment(segment, this.deps.transcripts.recent(interviewId, 8))) {
      this.deps.logger.debug({ sessionId }, 'Dropped duplicate final transcript segment');
      return;
    }
    this.deps.transcripts.append(segment);
    this.recordLatency(state, endMs, receivedAt);
    state.params.handlers.onFinal(segment);
  }

  private recordLatency(state: ActiveTranscription, audioEndMs: number, receivedAt: number): void {
    const sentAt = state.timeline.sentAtFor(audioEndMs);
    if (sentAt !== null) {
      this.deps.metrics.record(state.params.interviewId, 'transcription', receivedAt - sentAt);
    }
  }

  private async reconnect(state: ActiveTranscription): Promise<void> {
    if (state.reconnecting) return;
    state.reconnecting = true;
    state.stream = null;
    state.offsetMs = state.timeline.totalMs;
    const { maxReconnectAttempts, reconnectBaseDelayMs } = this.deps.config;

    for (let attempt = 1; attempt <= maxReconnectAttempts; attempt += 1) {
      if (state.closing) break;
      await abortableDelay(reconnectBaseDelayMs * 2 ** (attempt - 1));
      if (state.closing) break;
      try {
        state.stream = await state.params.provider.open(
          { sessionId: state.params.sessionId, format: state.params.format },
          this.createHandlers(state),
        );
        state.reconnecting = false;
        this.flushPending(state);
        this.deps.logger.info(
          { sessionId: state.params.sessionId, attempt },
          'Transcription stream reconnected',
        );
        return;
      } catch (error) {
        this.deps.logger.warn({ err: error, attempt }, 'Transcription reconnect attempt failed');
      }
    }

    state.reconnecting = false;
    if (state.closing) return;
    this.active.delete(state.params.sessionId);
    state.params.handlers.onError(
      new ProviderError(
        'TRANSCRIPTION_PROVIDER_ERROR',
        state.params.provider.descriptor.name,
        'Lost connection to the transcription provider',
        { recoverable: false },
      ),
      { fatal: true },
    );
  }

  private flushPending(state: ActiveTranscription): void {
    const backlog = state.pending.splice(0);
    for (const chunk of backlog) this.write(state.params.sessionId, chunk);
  }
}
