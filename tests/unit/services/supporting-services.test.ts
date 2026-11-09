import { describe, expect, it } from 'vitest';
import { InterviewContext } from '../../../src/mvc/models/interview.model';
import { ProviderRegistry } from '../../../src/providers/provider.registry';
import { MockLlmProvider } from '../../../src/providers/llm/mock-llm.provider';
import { MockTranscriptionProvider } from '../../../src/providers/transcription/mock-transcription.provider';
import { InMemoryAnswerRepository } from '../../../src/repositories/answer.repository';
import { InMemoryInterviewRepository } from '../../../src/repositories/interview.repository';
import { InMemoryQuestionRepository } from '../../../src/repositories/question.repository';
import { InMemoryTranscriptRepository } from '../../../src/repositories/transcript.repository';
import {
  buildAnswerMessages,
  buildSystemPrompt,
} from '../../../src/services/answer-prompt.builder';
import { AudioStreamService } from '../../../src/services/audio-stream.service';
import { InterviewService } from '../../../src/services/interview.service';
import { LatencyMetricsService } from '../../../src/services/latency-metrics.service';
import type { TranscriptionService } from '../../../src/services/transcription.service';
import { pcm } from '../../helpers/fakes';
import { makeSegment } from '../../helpers/factories';

describe('LatencyMetricsService', () => {
  it('computes stats and percentiles over a bounded window', () => {
    const metrics = new LatencyMetricsService({ windowSize: 5 });
    [100, 200, 300, 400, 500, 600].forEach((value) => metrics.record('i', 'llmFirstToken', value));
    const stats = metrics.snapshot('i').llmFirstToken!;
    expect(stats.count).toBe(6);
    expect(stats.min).toBe(200); // oldest sample evicted
    expect(stats.max).toBe(600);
    expect(stats.avg).toBe(400);
    expect(stats.p50).toBe(400);
    expect(stats.p95).toBe(600);
    expect(stats.last).toBe(600);
  });

  it('ignores negative and non-finite samples and isolates scopes', () => {
    const metrics = new LatencyMetricsService();
    metrics.record('a', 'transcription', -5);
    metrics.record('a', 'transcription', Number.NaN);
    metrics.record('b', 'transcription', 10);
    expect(metrics.snapshot('a').transcription).toBeNull();
    expect(metrics.snapshot('b').transcription?.last).toBe(10);
    metrics.clear('b');
    expect(metrics.snapshot('b').transcription).toBeNull();
  });
});

describe('answer prompt builder', () => {
  it('states honesty rules and the answer length target', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/Never invent employers/);
    expect(prompt).toMatch(/60–90 words/);
    expect(prompt).toMatch(/3–6 concise bullet points/);
  });

  it('includes resume, job description, instructions, conversation and question', () => {
    const messages = buildAnswerMessages({
      context: InterviewContext.create({
        resume: 'Go and Postgres',
        jobDescription: 'Platform team',
        instructions: 'Use STAR',
      }),
      question: 'Why this company?',
      recentTranscript: 'Hello',
    });
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    const user = messages[1]!.content;
    for (const part of [
      'Go and Postgres',
      'Platform team',
      'Use STAR',
      'Hello',
      'Why this company?',
    ]) {
      expect(user).toContain(part);
    }
  });

  it('marks missing context explicitly', () => {
    const [, user] = buildAnswerMessages({
      context: InterviewContext.empty(),
      question: 'Q?',
      recentTranscript: '',
    });
    expect(user!.content).toContain('<candidate_resume>\n(not provided)\n</candidate_resume>');
  });
});

describe('AudioStreamService', () => {
  function setup(writeResult = true) {
    const written: Uint8Array[] = [];
    const transcription = {
      write: (_sessionId: string, chunk: Uint8Array) => {
        written.push(chunk);
        return writeResult;
      },
    } as unknown as TranscriptionService;
    const metrics = new LatencyMetricsService();
    const service = new AudioStreamService({ transcription, metrics, now: () => 10_000 });
    service.register('s', 'i', { encoding: 'linear16', sampleRate: 16_000, channels: 1 });
    return { service, written, metrics };
  }
  const frame = (seq: number, capturedAt = 9_990) => ({
    type: 'audio.chunk' as const,
    seq,
    capturedAt,
    pcm: pcm(50),
  });

  it('forwards in-order frames, tracks stats and ingestion latency', () => {
    const { service, written, metrics } = setup();
    expect(service.ingest('s', frame(0)).accepted).toBe(true);
    expect(service.ingest('s', frame(1)).accepted).toBe(true);
    expect(written).toHaveLength(2);
    expect(service.stats('s')).toEqual({
      framesReceived: 2,
      framesDropped: 0,
      bytesReceived: 3_200,
      audioMs: 100,
    });
    expect(metrics.snapshot('i').audioIngestion?.last).toBe(10);
  });

  it('drops duplicate or out-of-order frames and frames for unknown sessions', () => {
    const { service } = setup();
    service.ingest('s', frame(5));
    expect(service.ingest('s', frame(5))).toEqual({ accepted: false, reason: 'out_of_order' });
    expect(service.ingest('s', frame(3))).toEqual({ accepted: false, reason: 'out_of_order' });
    expect(service.ingest('nope', frame(6))).toEqual({
      accepted: false,
      reason: 'unknown_session',
    });
    service.resetSequence('s');
    expect(service.ingest('s', frame(0)).accepted).toBe(true);
    expect(service.stats('s')?.framesDropped).toBe(2);
  });

  it('ignores implausible capture timestamps (clock skew)', () => {
    const { service, metrics } = setup();
    service.ingest('s', frame(0, 50_000)); // capture "in the future"
    expect(metrics.snapshot('i').audioIngestion).toBeNull();
  });

  it('counts frames rejected by transcription backpressure as dropped', () => {
    const { service } = setup(false);
    expect(service.ingest('s', frame(0))).toEqual({
      accepted: false,
      reason: 'transcription_backlog',
    });
    expect(service.stats('s')?.framesDropped).toBe(1);
  });
});

describe('InterviewService', () => {
  function setup() {
    let clock = 1_000;
    let id = 0;
    const interviews = new InMemoryInterviewRepository({ maxEntries: 2 });
    const transcripts = new InMemoryTranscriptRepository({ maxPerInterview: 10 });
    const service = new InterviewService({
      interviews,
      transcripts,
      questions: new InMemoryQuestionRepository({ maxPerInterview: 10 }),
      answers: new InMemoryAnswerRepository({ maxPerInterview: 10 }),
      metrics: new LatencyMetricsService(),
      providers: new ProviderRegistry({
        demo: { transcription: new MockTranscriptionProvider(), llm: new MockLlmProvider() },
        live: null,
      }),
      ids: () => `id-${++id}`,
      now: () => clock,
      ttlMs: 10_000,
    });
    return { service, interviews, transcripts, advance: (ms: number) => (clock += ms) };
  }

  it('creates, updates and fetches interviews', () => {
    const { service } = setup();
    const interview = service.create({ mode: 'demo', context: { resume: 'R' } });
    service.updateContext(interview.id, { instructions: 'Be concise' });
    expect(service.get(interview.id).context.instructions).toBe('Be concise');
    expect(() => service.get('missing')).toThrow(/not found/);
  });

  it('refuses Live Mode when the server has no live providers', () => {
    const { service } = setup();
    expect(() => service.create({ mode: 'live', context: {} })).toThrow(
      /DEEPGRAM_API_KEY|not configured/,
    );
  });

  it('deletes all derived data and purges expired idle interviews', () => {
    const { service, transcripts, advance } = setup();
    const first = service.create({ mode: 'demo', context: {} });
    transcripts.append(makeSegment({ text: 'hello' }));
    service.delete(first.id);
    expect(() => service.get(first.id)).toThrow();

    const second = service.create({ mode: 'demo', context: {} });
    const active = service.create({ mode: 'demo', context: {} });
    service.attachSession(active.id, 'session');
    advance(20_000);
    expect(service.purgeExpired()).toEqual([second.id]);
    expect(service.get(active.id).status).toBe('active');
  });

  it('evicts the oldest idle interview when the repository is full', () => {
    const { service } = setup();
    const a = service.create({ mode: 'demo', context: {} });
    service.create({ mode: 'demo', context: {} });
    service.create({ mode: 'demo', context: {} });
    expect(() => service.get(a.id)).toThrow();
  });
});
