import { createServerEvent, type QuestionDTO } from '@shared';
import type { Question } from '../models/question.model';

export function toQuestionDTO(question: Question): QuestionDTO {
  return {
    id: question.id,
    text: question.text,
    confidence: question.confidence,
    reasons: [...question.reasons],
    status: question.status,
    utteranceEndedAt: question.utteranceEndedAt,
    detectedAt: question.detectedAt,
  };
}

export function questionDetectedEvent(sessionId: string, question: Question) {
  return createServerEvent('question.detected', sessionId, { question: toQuestionDTO(question) });
}
