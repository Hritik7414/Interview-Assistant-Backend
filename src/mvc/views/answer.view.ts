import { createServerEvent, type AnswerDTO } from '@shared';
import type { Answer } from '../models/answer.model';

export function toAnswerDTO(answer: Answer): AnswerDTO {
  return {
    id: answer.id,
    questionId: answer.questionId,
    text: answer.text,
    status: answer.status,
    finishReason: answer.finishReason,
    provider: { ...answer.provider },
    startedAt: answer.startedAt,
    firstTokenAt: answer.firstTokenAt,
    completedAt: answer.completedAt,
    wordCount: answer.wordCount,
    errorMessage: answer.errorMessage,
  };
}

export function answerStartedEvent(sessionId: string, answer: Answer) {
  return createServerEvent('answer.started', sessionId, {
    answerId: answer.id,
    questionId: answer.questionId,
    provider: { ...answer.provider },
    startedAt: answer.startedAt,
  });
}

export function answerDeltaEvent(sessionId: string, answer: Answer, delta: string, index: number) {
  return createServerEvent('answer.delta', sessionId, { answerId: answer.id, delta, index });
}

export function answerCompletedEvent(sessionId: string, answer: Answer) {
  return createServerEvent('answer.completed', sessionId, {
    answer: toAnswerDTO(answer),
    latency: {
      firstTokenMs: answer.firstTokenLatencyMs,
      totalMs: answer.totalLatencyMs ?? 0,
    },
  });
}
