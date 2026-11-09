import type { QuestionStatus } from '@shared';
import { DomainError } from './domain-error';
import { clampUnit } from './numbers';
import { normalizeText, textSimilarity } from './text';

export interface CreateQuestionProps {
  id: string;
  interviewId: string;
  sessionId: string;
  text: string;
  confidence: number;
  reasons: readonly string[];
  sourceSegmentIds: readonly string[];
  /** When the last transcript fragment of the question arrived (server clock). */
  utteranceEndedAt: number;
  detectedAt: number;
}

const ALLOWED_TRANSITIONS: Record<QuestionStatus, readonly QuestionStatus[]> = {
  detected: ['answering', 'cancelled'],
  answering: ['answered', 'cancelled', 'failed'],
  answered: [],
  cancelled: [],
  failed: [],
};

/** An interviewer question detected in the transcript, with a small answer lifecycle. */
export class Question {
  readonly id: string;
  readonly interviewId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly sourceSegmentIds: readonly string[];
  readonly utteranceEndedAt: number;
  readonly detectedAt: number;
  private _status: QuestionStatus = 'detected';

  private constructor(props: CreateQuestionProps) {
    this.id = props.id;
    this.interviewId = props.interviewId;
    this.sessionId = props.sessionId;
    this.text = props.text;
    this.confidence = props.confidence;
    this.reasons = [...props.reasons];
    this.sourceSegmentIds = [...props.sourceSegmentIds];
    this.utteranceEndedAt = props.utteranceEndedAt;
    this.detectedAt = props.detectedAt;
  }

  static create(props: CreateQuestionProps): Question {
    const text = props.text.trim();
    if (text === '') throw new DomainError('VALIDATION_ERROR', 'Question text cannot be empty');
    return new Question({ ...props, text, confidence: clampUnit(props.confidence) });
  }

  get status(): QuestionStatus {
    return this._status;
  }

  get normalizedText(): string {
    return normalizeText(this.text);
  }

  /** Detection latency: silence wait + processing, as perceived by the user. */
  get detectionLatencyMs(): number {
    return Math.max(0, this.detectedAt - this.utteranceEndedAt);
  }

  similarityTo(other: Question | string): number {
    return textSimilarity(this.text, typeof other === 'string' ? other : other.text);
  }

  markAnswering(): void {
    this.transition('answering');
  }

  markAnswered(): void {
    this.transition('answered');
  }

  markCancelled(): void {
    this.transition('cancelled');
  }

  markFailed(): void {
    this.transition('failed');
  }

  private transition(next: QuestionStatus): void {
    if (!ALLOWED_TRANSITIONS[this._status].includes(next)) {
      throw new DomainError('CONFLICT', `Question cannot move from ${this._status} to ${next}`);
    }
    this._status = next;
  }
}
