import type { AnswerStatus, FinishReason, ProviderDescriptor } from '@shared';
import { DomainError } from './domain-error';
import { countWords } from './text';

export interface CreateAnswerProps {
  id: string;
  questionId: string;
  interviewId: string;
  sessionId: string;
  provider: ProviderDescriptor;
  startedAt: number;
}

/** A streamed LLM answer. Accumulates deltas and records its own latency milestones. */
export class Answer {
  readonly id: string;
  readonly questionId: string;
  readonly interviewId: string;
  readonly sessionId: string;
  readonly provider: ProviderDescriptor;
  readonly startedAt: number;
  private _status: AnswerStatus = 'pending';
  private _text = '';
  private _deltaCount = 0;
  private _firstTokenAt: number | null = null;
  private _completedAt: number | null = null;
  private _finishReason: FinishReason | null = null;
  private _errorMessage: string | null = null;

  private constructor(props: CreateAnswerProps) {
    this.id = props.id;
    this.questionId = props.questionId;
    this.interviewId = props.interviewId;
    this.sessionId = props.sessionId;
    this.provider = { ...props.provider };
    this.startedAt = props.startedAt;
  }

  static create(props: CreateAnswerProps): Answer {
    return new Answer(props);
  }

  get status(): AnswerStatus {
    return this._status;
  }

  get text(): string {
    return this._text;
  }

  get firstTokenAt(): number | null {
    return this._firstTokenAt;
  }

  get completedAt(): number | null {
    return this._completedAt;
  }

  get finishReason(): FinishReason | null {
    return this._finishReason;
  }

  get errorMessage(): string | null {
    return this._errorMessage;
  }

  get isTerminal(): boolean {
    return (
      this._status === 'completed' || this._status === 'cancelled' || this._status === 'failed'
    );
  }

  get wordCount(): number {
    return countWords(this._text);
  }

  get firstTokenLatencyMs(): number | null {
    return this._firstTokenAt === null ? null : this._firstTokenAt - this.startedAt;
  }

  get totalLatencyMs(): number | null {
    return this._completedAt === null ? null : this._completedAt - this.startedAt;
  }

  /** Appends streamed text and returns the delta index (0 for the first token). */
  appendDelta(delta: string, at: number): number {
    this.assertNotTerminal('append to');
    if (this._firstTokenAt === null) this._firstTokenAt = at;
    this._status = 'streaming';
    this._text += delta;
    const index = this._deltaCount;
    this._deltaCount += 1;
    return index;
  }

  complete(reason: Extract<FinishReason, 'stop' | 'length'>, at: number): void {
    this.finish('completed', reason, at);
    this._text = this._text.trim();
  }

  cancel(at: number): void {
    if (this.isTerminal) return;
    this.finish('cancelled', 'cancelled', at);
  }

  fail(message: string, at: number): void {
    if (this.isTerminal) return;
    this._errorMessage = message;
    this.finish('failed', 'error', at);
  }

  private finish(status: AnswerStatus, reason: FinishReason, at: number): void {
    this.assertNotTerminal('finish');
    this._status = status;
    this._finishReason = reason;
    this._completedAt = at;
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal) {
      throw new DomainError(
        'CONFLICT',
        `Cannot ${action} an answer that is already ${this._status}`,
      );
    }
  }
}
