import { describe, expect, it } from 'vitest';
import {
  analyzeUtterance,
  splitSentences,
  stripFillers,
} from '../../../src/services/question-detection.heuristics';

const config = { minWords: 3, confidenceThreshold: 0.5 };
const analyze = (text: string) => analyzeUtterance(text, config);

describe('stripFillers', () => {
  it.each([
    ['Um, so how would you start?', 'so how would you start?'],
    [
      'How would you design a system that, uh, scales?',
      'How would you design a system that scales?',
    ],
    ['And, um, what is your approach?', 'And what is your approach?'],
    ['Is it fast, uh?', 'Is it fast?'],
    ['Do you know Kubernetes?', 'Do you know Kubernetes?'],
  ])('%s → %s', (input, expected) => {
    expect(stripFillers(input)).toBe(expected);
  });
});

describe('splitSentences', () => {
  it('splits on terminal punctuation', () => {
    expect(splitSentences('Great. How are you? Fine!')).toEqual([
      'Great.',
      'How are you?',
      'Fine!',
    ]);
  });
});

describe('analyzeUtterance — questions', () => {
  it.each([
    'How would you design a real-time notification system?',
    'How would you design a real-time notification system', // no punctuation
    'Could you walk me through your background',
    'Um, so to start, could you walk me through your background and what drew you to this role?',
    'Tell me about a time you disagreed with a teammate.',
    'Walk me through how you would debug a memory leak',
    'Describe your experience with distributed tracing.',
    "I'd like to hear about a project you're proud of.",
    'What is your approach to testing distributed systems?',
    'Which database would you pick for time series data?',
    'Do you have any questions for us?',
    'Is there a project where you owned the architecture end to end?',
    'Great, thanks. So, what motivates you to leave your current role?',
  ])('detects: %s', (text) => {
    const result = analyze(text);
    expect(result.isQuestion, JSON.stringify(result)).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('drops leading acknowledgements and discourse markers from the question text', () => {
    const result = analyze('Okay. And, um, what is your approach to testing distributed systems?');
    expect(result.questionText).toBe('What is your approach to testing distributed systems?');
  });

  it('keeps one sentence of lead-in context', () => {
    const result = analyze("Let's talk about databases. How would you shard a users table?");
    expect(result.questionText).toBe(
      "Let's talk about databases. How would you shard a users table?",
    );
  });
});

describe('analyzeUtterance — non-questions', () => {
  it.each([
    ['Hi, thanks for joining us today.', 'low_confidence'],
    ["Great, thanks. Let's shift to some technical depth.", 'low_confidence'],
    ["That's everything from my side. Thanks so much for your time today.", 'low_confidence'],
    ['What I did was build a streaming pipeline with Kafka.', 'low_confidence'],
    ['I think the key trade-off is consistency versus latency.', 'low_confidence'],
    ['Great, thanks.', 'acknowledgement'],
    ['Okay.', 'acknowledgement'],
    ['Um, uh.', 'too_short'],
    ['Why?', 'too_short'],
    ['Can you hear me okay?', 'small_talk'],
    ['How are you doing today?', 'small_talk'],
  ])('rejects: %s (%s)', (text, rejection) => {
    const result = analyze(text);
    expect(result.isQuestion).toBe(false);
    expect(result.rejection).toBe(rejection);
  });

  it('honours the configurable minimum word count', () => {
    expect(
      analyzeUtterance('Why Kafka?', { minWords: 3, confidenceThreshold: 0.5 }).isQuestion,
    ).toBe(false);
    expect(
      analyzeUtterance('Why Kafka?', { minWords: 1, confidenceThreshold: 0.5 }).isQuestion,
    ).toBe(true);
  });

  it('honours the configurable confidence threshold', () => {
    const text = 'Tell me about your last project';
    expect(analyzeUtterance(text, { minWords: 3, confidenceThreshold: 0.5 }).isQuestion).toBe(true);
    expect(analyzeUtterance(text, { minWords: 3, confidenceThreshold: 0.95 }).isQuestion).toBe(
      false,
    );
  });
});
