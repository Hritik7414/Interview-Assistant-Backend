import { randomUUID } from 'node:crypto';
import { Interview, InterviewContext } from '../../src/mvc/models/interview.model';
import { Question } from '../../src/mvc/models/question.model';
import { TranscriptSegment } from '../../src/mvc/models/transcript.model';

export const INTERVIEW_ID = '11111111-1111-4111-8111-111111111111';
export const SESSION_ID = '22222222-2222-4222-8222-222222222222';

export interface SegmentOverrides {
  text: string;
  startMs?: number;
  endMs?: number;
  isFinal?: boolean;
  speechFinal?: boolean;
  receivedAt?: number;
  id?: string;
}

export function makeSegment(overrides: SegmentOverrides): TranscriptSegment {
  return TranscriptSegment.create({
    id: overrides.id ?? randomUUID(),
    interviewId: INTERVIEW_ID,
    sessionId: SESSION_ID,
    text: overrides.text,
    isFinal: overrides.isFinal ?? true,
    startMs: overrides.startMs ?? 0,
    endMs: overrides.endMs ?? 1_000,
    confidence: 0.95,
    speechFinal: overrides.speechFinal ?? false,
    receivedAt: overrides.receivedAt ?? Date.now(),
  });
}

export function makeQuestion(text: string, detectedAt = Date.now()): Question {
  return Question.create({
    id: randomUUID(),
    interviewId: INTERVIEW_ID,
    sessionId: SESSION_ID,
    text,
    confidence: 0.9,
    reasons: ['question-mark'],
    sourceSegmentIds: [],
    utteranceEndedAt: detectedAt - 500,
    detectedAt,
  });
}

export function makeInterview(
  context: Partial<{ resume: string; jobDescription: string; instructions: string }> = {},
) {
  return Interview.create({
    id: INTERVIEW_ID,
    mode: 'demo',
    context: InterviewContext.create(context),
    now: Date.now(),
  });
}
