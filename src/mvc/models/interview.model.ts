import {
  CONTEXT_LIMITS,
  type InterviewContextDTO,
  type InterviewMode,
  type InterviewStatus,
} from '@shared';
import { DomainError } from './domain-error';

type ContextField = keyof InterviewContextDTO;

/**
 * Immutable value object holding the candidate's resume, job description and
 * instructions. `toJSON()` deliberately serialises only character counts so the
 * content cannot leak into logs or error reports by accident.
 */
export class InterviewContext {
  private constructor(
    readonly resume: string,
    readonly jobDescription: string,
    readonly instructions: string,
  ) {}

  static empty(): InterviewContext {
    return new InterviewContext('', '', '');
  }

  static create(input: Partial<InterviewContextDTO> = {}): InterviewContext {
    const resume = sanitize(input.resume, 'resume');
    const jobDescription = sanitize(input.jobDescription, 'jobDescription');
    const instructions = sanitize(input.instructions, 'instructions');
    return new InterviewContext(resume, jobDescription, instructions);
  }

  merge(patch: Partial<InterviewContextDTO>): InterviewContext {
    return InterviewContext.create({
      resume: patch.resume ?? this.resume,
      jobDescription: patch.jobDescription ?? this.jobDescription,
      instructions: patch.instructions ?? this.instructions,
    });
  }

  get isEmpty(): boolean {
    return this.resume === '' && this.jobDescription === '' && this.instructions === '';
  }

  get characterCounts() {
    return {
      resumeChars: this.resume.length,
      jobDescriptionChars: this.jobDescription.length,
      instructionsChars: this.instructions.length,
    };
  }

  toJSON() {
    return this.characterCounts;
  }
}

function sanitize(value: string | undefined, field: ContextField): string {
  const text = (value ?? '').trim();
  const limit = CONTEXT_LIMITS[field];
  if (text.length > limit) {
    throw new DomainError('VALIDATION_ERROR', `${field} exceeds ${limit} characters`);
  }
  return text;
}

export interface CreateInterviewProps {
  id: string;
  mode: InterviewMode;
  context: InterviewContext;
  now: number;
}

/**
 * Aggregate root for one interview. At most one realtime session may be
 * attached at a time; sessions can be started again after they stop.
 */
export class Interview {
  readonly id: string;
  readonly mode: InterviewMode;
  readonly createdAt: number;
  private _context: InterviewContext;
  private _activeSessionId: string | null = null;
  private _sessionCount = 0;
  private _updatedAt: number;

  private constructor(props: CreateInterviewProps) {
    this.id = props.id;
    this.mode = props.mode;
    this.createdAt = props.now;
    this._updatedAt = props.now;
    this._context = props.context;
  }

  static create(props: CreateInterviewProps): Interview {
    return new Interview(props);
  }

  get context(): InterviewContext {
    return this._context;
  }

  get status(): InterviewStatus {
    return this._activeSessionId === null ? 'idle' : 'active';
  }

  get activeSessionId(): string | null {
    return this._activeSessionId;
  }

  get sessionCount(): number {
    return this._sessionCount;
  }

  get updatedAt(): number {
    return this._updatedAt;
  }

  attachSession(sessionId: string, now: number): void {
    if (this._activeSessionId !== null && this._activeSessionId !== sessionId) {
      throw new DomainError(
        'SESSION_ALREADY_ACTIVE',
        'This interview already has an active listening session',
      );
    }
    if (this._activeSessionId === sessionId) return;
    this._activeSessionId = sessionId;
    this._sessionCount += 1;
    this._updatedAt = now;
  }

  detachSession(sessionId: string, now: number): void {
    if (this._activeSessionId !== sessionId) return;
    this._activeSessionId = null;
    this._updatedAt = now;
  }

  updateContext(patch: Partial<InterviewContextDTO>, now: number): void {
    this._context = this._context.merge(patch);
    this._updatedAt = now;
  }
}
