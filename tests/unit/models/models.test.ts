import { CONTEXT_LIMITS } from '@shared';
import { describe, expect, it } from 'vitest';
import { Answer } from '../../../src/mvc/models/answer.model';
import { DomainError } from '../../../src/mvc/models/domain-error';
import { Interview, InterviewContext } from '../../../src/mvc/models/interview.model';
import { textSimilarity } from '../../../src/mvc/models/text';
import {
  isDuplicateSegment,
  joinSegmentText,
  recentTranscriptText,
  TranscriptSegment,
} from '../../../src/mvc/models/transcript.model';
import { makeQuestion, makeSegment } from '../../helpers/factories';

describe('InterviewContext', () => {
  it('trims input and never serialises personal content', () => {
    const context = InterviewContext.create({
      resume: '  Staff engineer at Acme  ',
      instructions: 'Be brief',
    });
    expect(context.resume).toBe('Staff engineer at Acme');
    expect(JSON.stringify(context)).not.toContain('Acme');
    expect(JSON.parse(JSON.stringify(context))).toEqual({
      resumeChars: 22,
      jobDescriptionChars: 0,
      instructionsChars: 8,
    });
  });

  it('rejects oversized fields', () => {
    expect(() =>
      InterviewContext.create({ resume: 'x'.repeat(CONTEXT_LIMITS.resume + 1) }),
    ).toThrow(DomainError);
  });

  it('merges partial updates immutably', () => {
    const original = InterviewContext.create({ resume: 'A', jobDescription: 'B' });
    const merged = original.merge({ jobDescription: 'C' });
    expect(merged).not.toBe(original);
    expect([merged.resume, merged.jobDescription]).toEqual(['A', 'C']);
    expect(original.jobDescription).toBe('B');
  });
});

describe('Interview', () => {
  const create = () =>
    Interview.create({ id: 'i-1', mode: 'demo', context: InterviewContext.empty(), now: 1_000 });

  it('allows a single active session at a time', () => {
    const interview = create();
    interview.attachSession('s-1', 2_000);
    expect(interview.status).toBe('active');
    expect(() => interview.attachSession('s-2', 2_100)).toThrow(/already has an active/);
    interview.attachSession('s-1', 2_200); // idempotent
    expect(interview.sessionCount).toBe(1);
  });

  it('becomes idle when its session detaches and can start again', () => {
    const interview = create();
    interview.attachSession('s-1', 2_000);
    interview.detachSession('other', 2_500);
    expect(interview.status).toBe('active');
    interview.detachSession('s-1', 3_000);
    expect(interview.status).toBe('idle');
    expect(interview.updatedAt).toBe(3_000);
    interview.attachSession('s-2', 4_000);
    expect(interview.sessionCount).toBe(2);
  });
});

describe('TranscriptSegment', () => {
  it('normalises text, time order and confidence', () => {
    const segment = TranscriptSegment.create({
      id: 'x',
      interviewId: 'i',
      sessionId: 's',
      text: '  hello    world ',
      isFinal: false,
      startMs: 900,
      endMs: 500,
      confidence: 3,
      speechFinal: true,
      receivedAt: 0,
    });
    expect(segment.text).toBe('hello world');
    expect([segment.startMs, segment.endMs]).toEqual([500, 900]);
    expect(segment.confidence).toBe(1);
    expect(segment.speechFinal).toBe(false); // only finals can be speech-final
  });

  it('detects replayed duplicate finals but not repeated phrases at different times', () => {
    const original = makeSegment({ text: 'How are you?', startMs: 1_000, endMs: 2_000 });
    const replay = makeSegment({ text: 'how are you', startMs: 1_050, endMs: 2_000 });
    const later = makeSegment({ text: 'How are you?', startMs: 9_000, endMs: 10_000 });
    expect(isDuplicateSegment(replay, [original])).toBe(true);
    expect(isDuplicateSegment(later, [original])).toBe(false);
  });

  it('aggregates and truncates transcript text at word boundaries', () => {
    const segments = [
      makeSegment({ text: 'one two three' }),
      makeSegment({ text: 'four five six' }),
    ];
    expect(joinSegmentText(segments)).toBe('one two three four five six');
    expect(recentTranscriptText(segments, 100)).toBe('one two three four five six');
    expect(recentTranscriptText(segments, 10)).toBe('…five six');
  });
});

describe('Question', () => {
  it('follows the answer lifecycle and rejects invalid transitions', () => {
    const question = makeQuestion('What is your biggest strength?');
    question.markAnswering();
    question.markAnswered();
    expect(question.status).toBe('answered');
    expect(() => question.markAnswering()).toThrow(DomainError);
  });

  it('computes similarity on content words', () => {
    expect(textSimilarity('How would you design a cache?', 'how would you design a cache')).toBe(1);
    expect(textSimilarity('What is a cache?', 'Why is a cache?')).toBeLessThan(0.8);
    expect(
      makeQuestion('Tell me about Kafka').similarityTo('Describe your Postgres experience'),
    ).toBe(0);
  });

  it('rejects empty text', () => {
    expect(() => makeQuestion('   ')).toThrow(DomainError);
  });
});

describe('Answer', () => {
  const create = () =>
    Answer.create({
      id: 'a',
      questionId: 'q',
      interviewId: 'i',
      sessionId: 's',
      provider: { name: 'mock', model: null, simulated: true },
      startedAt: 1_000,
    });

  it('accumulates deltas and latency milestones', () => {
    const answer = create();
    expect(answer.appendDelta('- One ', 1_300)).toBe(0);
    expect(answer.appendDelta('two three', 1_400)).toBe(1);
    answer.complete('stop', 2_000);
    expect(answer.status).toBe('completed');
    expect(answer.text).toBe('- One two three');
    expect(answer.wordCount).toBe(3);
    expect(answer.firstTokenLatencyMs).toBe(300);
    expect(answer.totalLatencyMs).toBe(1_000);
  });

  it('cannot change after reaching a terminal state', () => {
    const answer = create();
    answer.cancel(1_100);
    expect(answer.finishReason).toBe('cancelled');
    expect(() => answer.appendDelta('late', 1_200)).toThrow(DomainError);
    answer.fail('ignored', 1_300); // no-op once terminal
    expect(answer.status).toBe('cancelled');
  });
});
