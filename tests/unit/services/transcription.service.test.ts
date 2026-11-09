import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptSegment } from '../../../src/mvc/models/transcript.model';
import { InMemoryTranscriptRepository } from '../../../src/repositories/transcript.repository';
import { LatencyMetricsService } from '../../../src/services/latency-metrics.service';
import {
  TranscriptionService,
  type TranscriptionSessionHandlers,
} from '../../../src/services/transcription.service';
import { createSilentLogger } from '../../../src/utils/logger';
import { FakeTranscriptionProvider, pcm } from '../../helpers/fakes';
import { INTERVIEW_ID, SESSION_ID } from '../../helpers/factories';

const FORMAT = { encoding: 'linear16', sampleRate: 16_000, channels: 1 } as const;

function setup(
  config = { maxPendingChunks: 3, maxReconnectAttempts: 2, reconnectBaseDelayMs: 10 },
) {
  let clock = 1_000;
  let id = 0;
  const repository = new InMemoryTranscriptRepository({ maxPerInterview: 100 });
  const metrics = new LatencyMetricsService();
  const provider = new FakeTranscriptionProvider();
  const service = new TranscriptionService({
    transcripts: repository,
    metrics,
    config,
    logger: createSilentLogger(),
    ids: () => `seg-${++id}`,
    now: () => clock,
  });
  const partials: TranscriptSegment[] = [];
  const finals: TranscriptSegment[] = [];
  const handlers: TranscriptionSessionHandlers = {
    onPartial: (segment) => partials.push(segment),
    onFinal: (segment) => finals.push(segment),
    onUtteranceEnd: vi.fn(),
    onSpeechStarted: vi.fn(),
    onError: vi.fn(),
  };
  const open = () =>
    service.open({
      sessionId: SESSION_ID,
      interviewId: INTERVIEW_ID,
      provider,
      format: FORMAT,
      handlers,
    });
  return {
    service,
    provider,
    repository,
    metrics,
    handlers,
    partials,
    finals,
    open,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe('TranscriptionService', () => {
  afterEach(() => vi.useRealTimers());

  it('forwards audio and emits partials with a stable id that the final reuses', async () => {
    const ctx = setup();
    await ctx.open();
    ctx.service.write(SESSION_ID, pcm(100));
    expect(ctx.provider.last.written).toHaveLength(1);

    ctx.provider.last.emit({ text: 'how would', startMs: 0, endMs: 50 });
    ctx.provider.last.emit({ text: 'how would', startMs: 0, endMs: 60 }); // unchanged → skipped
    ctx.provider.last.emit({ text: 'how would you', startMs: 0, endMs: 90 });
    ctx.provider.last.emitFinal('How would you?', 0, 100, true);

    expect(ctx.partials.map((s) => s.text)).toEqual(['how would', 'how would you']);
    expect(ctx.finals).toHaveLength(1);
    expect(ctx.finals[0]!.id).toBe(ctx.partials[0]!.id);
    expect(ctx.finals[0]!.speechFinal).toBe(true);
    expect(ctx.repository.countByInterview(INTERVIEW_ID)).toBe(1);
  });

  it('ignores empty finals and duplicate replays', async () => {
    const ctx = setup();
    await ctx.open();
    ctx.provider.last.emitFinal('   ', 0, 500);
    ctx.provider.last.emitFinal('Tell me about Kafka.', 500, 1_500);
    ctx.provider.last.emitFinal('Tell me about Kafka.', 520, 1_500);
    expect(ctx.finals.map((s) => s.text)).toEqual(['Tell me about Kafka.']);
  });

  it('measures transcription latency from when the covered audio was sent', async () => {
    const ctx = setup();
    await ctx.open();
    ctx.service.write(SESSION_ID, pcm(100)); // audio 0–100 ms sent at t=1000
    ctx.tick(250);
    ctx.provider.last.emitFinal('Hello there friend.', 0, 100);
    expect(ctx.metrics.snapshot(INTERVIEW_ID).transcription?.last).toBe(250);
  });

  it('reconnects after an unexpected provider close, buffering bounded audio meanwhile', async () => {
    vi.useFakeTimers();
    const ctx = setup();
    await ctx.open();
    ctx.service.write(SESSION_ID, pcm(1_000));
    ctx.provider.last.drop();

    // While reconnecting, only `maxPendingChunks` chunks are retained.
    expect(ctx.service.write(SESSION_ID, pcm(50))).toBe(true);
    ctx.service.write(SESSION_ID, pcm(50));
    ctx.service.write(SESSION_ID, pcm(50));
    expect(ctx.service.write(SESSION_ID, pcm(50))).toBe(false);

    await vi.advanceTimersByTimeAsync(20);
    expect(ctx.provider.streams).toHaveLength(2);
    expect(ctx.provider.last.written).toHaveLength(3);

    // Results from the new stream are offset by the audio already sent (1000 ms).
    ctx.provider.last.emitFinal('Back again.', 0, 100);
    expect(ctx.finals.at(-1)!.startMs).toBe(1_000);
  });

  it('reports a fatal error when reconnecting keeps failing', async () => {
    vi.useFakeTimers();
    const ctx = setup();
    await ctx.open();
    ctx.provider.openErrors = [new Error('down'), new Error('still down')];
    ctx.provider.last.drop();
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.handlers.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'TRANSCRIPTION_PROVIDER_ERROR' }),
      { fatal: true },
    );
    expect(ctx.service.write(SESSION_ID, pcm(50))).toBe(false);
  });

  it('closes the provider stream gracefully and stops accepting audio', async () => {
    const ctx = setup();
    await ctx.open();
    await ctx.service.close(SESSION_ID);
    expect(ctx.provider.last.closed).toBe(true);
    expect(ctx.service.write(SESSION_ID, pcm(50))).toBe(false);
  });

  it('propagates provider open failures as AppErrors', async () => {
    const ctx = setup();
    ctx.provider.openErrors = [new Error('bad key')];
    await expect(ctx.open()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
