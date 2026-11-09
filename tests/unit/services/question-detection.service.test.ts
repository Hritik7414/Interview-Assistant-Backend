import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionDetectionConfig } from '../../../src/config/ai.config';
import type { Question } from '../../../src/mvc/models/question.model';
import { InMemoryQuestionRepository } from '../../../src/repositories/question.repository';
import { LatencyMetricsService } from '../../../src/services/latency-metrics.service';
import {
  QuestionDetectionService,
  type QuestionDetector,
} from '../../../src/services/question-detection.service';
import { createSilentLogger } from '../../../src/utils/logger';
import { INTERVIEW_ID, makeSegment, SESSION_ID } from '../../helpers/factories';

const config: QuestionDetectionConfig = {
  silenceThresholdMs: 1_000,
  minWords: 3,
  confidenceThreshold: 0.5,
  duplicateWindowMs: 60_000,
  duplicateSimilarity: 0.8,
  maxUtteranceChars: 500,
};

describe('QuestionDetector', () => {
  let detected: Question[];
  let detector: QuestionDetector;
  let metrics: LatencyMetricsService;
  let repository: InMemoryQuestionRepository;

  beforeEach(() => {
    vi.useFakeTimers({ now: 100_000 });
    detected = [];
    metrics = new LatencyMetricsService();
    repository = new InMemoryQuestionRepository({ maxPerInterview: 50 });
    let counter = 0;
    const service = new QuestionDetectionService({
      config,
      questions: repository,
      metrics,
      logger: createSilentLogger(),
      ids: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
      now: () => Date.now(),
    });
    detector = service.createDetector({
      sessionId: SESSION_ID,
      interviewId: INTERVIEW_ID,
      onQuestion: (question) => detected.push(question),
    });
  });

  afterEach(() => {
    detector.dispose();
    vi.useRealTimers();
  });

  it('waits for the configured silence before evaluating', () => {
    detector.addFinal(
      makeSegment({ text: 'Tell me about a time you led a project', receivedAt: Date.now() }),
    );
    vi.advanceTimersByTime(999);
    expect(detected).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(detected).toHaveLength(1);
    expect(detected[0]!.reasons).toContain('trigger:silence');
  });

  it('postpones detection while interim speech keeps arriving', () => {
    detector.addFinal(makeSegment({ text: 'Tell me about a time', endMs: 1_000 }));
    vi.advanceTimersByTime(800);
    detector.notePartial(makeSegment({ text: 'you led a', isFinal: false }));
    vi.advanceTimersByTime(800);
    expect(detected).toHaveLength(0);
    detector.addFinal(makeSegment({ text: 'you led a project.', startMs: 1_100, endMs: 2_000 }));
    vi.advanceTimersByTime(1_000);
    expect(detected).toHaveLength(1);
    expect(detected[0]!.text).toBe('Tell me about a time you led a project.');
  });

  it('evaluates immediately on a provider utterance-end signal', () => {
    detector.addFinal(makeSegment({ text: 'Describe your experience with Kubernetes.' }));
    detector.onUtteranceEnd();
    expect(detected).toHaveLength(1);
    expect(detected[0]!.reasons).toContain('trigger:utterance-end');
  });

  it('takes the fast path for speech-final segments ending in a question mark', () => {
    detector.addFinal(
      makeSegment({ text: 'How would you scale a chat service?', speechFinal: true }),
    );
    expect(detected).toHaveLength(1);
    expect(detected[0]!.reasons).toContain('trigger:speech-final');
  });

  it('splits utterances separated by a long audio gap', () => {
    detector.addFinal(
      makeSegment({ text: 'What is your favourite database?', startMs: 0, endMs: 2_000 }),
    );
    detector.addFinal(makeSegment({ text: 'Okay great.', startMs: 5_000, endMs: 6_000 }));
    expect(detected).toHaveLength(1);
    expect(detected[0]!.reasons).toContain('trigger:audio-gap');
  });

  it('ignores statements and acknowledgements', () => {
    detector.addFinal(makeSegment({ text: 'Thanks for joining us today.' }));
    detector.onUtteranceEnd();
    detector.addFinal(makeSegment({ text: 'Great, thanks.' }));
    detector.onUtteranceEnd();
    expect(detected).toHaveLength(0);
  });

  it('suppresses duplicates within the window but not after it', () => {
    detector.addFinal(makeSegment({ text: 'How would you design a cache?' }));
    detector.onUtteranceEnd();
    detector.addFinal(makeSegment({ text: 'So how would you design a cache?' }));
    detector.onUtteranceEnd();
    expect(detected).toHaveLength(1);

    vi.advanceTimersByTime(config.duplicateWindowMs + 1);
    detector.addFinal(makeSegment({ text: 'How would you design a cache?' }));
    detector.onUtteranceEnd();
    expect(detected).toHaveLength(2);
  });

  it('persists questions and records detection latency', () => {
    detector.addFinal(makeSegment({ text: 'Why do you want this job?', receivedAt: Date.now() }));
    vi.advanceTimersByTime(1_000);
    expect(repository.countByInterview(INTERVIEW_ID)).toBe(1);
    expect(metrics.snapshot(INTERVIEW_ID).questionDetection?.last).toBe(1_000);
  });

  it('reset() discards pending text and dispose() stops all detection', () => {
    detector.addFinal(makeSegment({ text: 'Tell me about yourself please' }));
    detector.reset();
    vi.advanceTimersByTime(5_000);
    expect(detected).toHaveLength(0);
    detector.dispose();
    detector.addFinal(makeSegment({ text: 'What is your greatest strength?', speechFinal: true }));
    expect(detected).toHaveLength(0);
  });
});
