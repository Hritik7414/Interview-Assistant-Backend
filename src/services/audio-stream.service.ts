import { pcmBytesToMs, type AudioChunkEvent, type AudioFormat, type AudioStats } from '@shared';
import type { Clock } from '../utils/runtime';
import type { LatencyMetricsService } from './latency-metrics.service';
import type { TranscriptionService } from './transcription.service';

export type AudioIngestOutcome =
  | { accepted: true }
  | { accepted: false; reason: 'unknown_session' | 'out_of_order' | 'transcription_backlog' };

interface AudioSessionState {
  interviewId: string;
  format: AudioFormat;
  lastSeq: number | null;
  stats: AudioStats;
}

/** Maximum plausible capture→server delay; larger values indicate clock skew, not latency. */
const MAX_PLAUSIBLE_INGESTION_MS = 60_000;

/**
 * Ingests decoded audio frames for a session: enforces ordering, tracks stats,
 * records ingestion latency and forwards PCM to the transcription service.
 */
export class AudioStreamService {
  private readonly sessions = new Map<string, AudioSessionState>();

  constructor(
    private readonly deps: {
      transcription: TranscriptionService;
      metrics: LatencyMetricsService;
      now: Clock;
    },
  ) {}

  register(sessionId: string, interviewId: string, format: AudioFormat): void {
    this.sessions.set(sessionId, {
      interviewId,
      format,
      lastSeq: null,
      stats: { framesReceived: 0, framesDropped: 0, bytesReceived: 0, audioMs: 0 },
    });
  }

  /** A reconnecting client may restart its sequence numbers. */
  resetSequence(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) state.lastSeq = null;
  }

  ingest(sessionId: string, frame: AudioChunkEvent): AudioIngestOutcome {
    const state = this.sessions.get(sessionId);
    if (!state) return { accepted: false, reason: 'unknown_session' };

    if (state.lastSeq !== null && frame.seq <= state.lastSeq) {
      state.stats.framesDropped += 1;
      return { accepted: false, reason: 'out_of_order' };
    }
    state.lastSeq = frame.seq;

    const receivedAt = this.deps.now();
    const ingestionMs = receivedAt - frame.capturedAt;
    if (ingestionMs >= 0 && ingestionMs < MAX_PLAUSIBLE_INGESTION_MS) {
      this.deps.metrics.record(state.interviewId, 'audioIngestion', ingestionMs);
    }

    state.stats.framesReceived += 1;
    state.stats.bytesReceived += frame.pcm.byteLength;
    state.stats.audioMs += pcmBytesToMs(frame.pcm.byteLength, state.format.sampleRate);

    if (!this.deps.transcription.write(sessionId, frame.pcm)) {
      state.stats.framesDropped += 1;
      return { accepted: false, reason: 'transcription_backlog' };
    }
    return { accepted: true };
  }

  stats(sessionId: string): AudioStats | undefined {
    const state = this.sessions.get(sessionId);
    return state ? { ...state.stats, audioMs: Math.round(state.stats.audioMs) } : undefined;
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
