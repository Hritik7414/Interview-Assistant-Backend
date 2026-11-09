import type { InterviewContextDTO, InterviewMode } from '@shared';
import { Interview, InterviewContext } from '../mvc/models/interview.model';
import type { ProviderCatalog } from '../providers/provider.registry';
import type { AnswerRepository } from '../repositories/answer.repository';
import type { InterviewRepository } from '../repositories/interview.repository';
import type { QuestionRepository } from '../repositories/question.repository';
import type { TranscriptRepository } from '../repositories/transcript.repository';
import { AppError, NotFoundError } from '../utils/errors';
import type { Clock, IdGenerator } from '../utils/runtime';
import type { LatencyMetricsService } from './latency-metrics.service';

export interface InterviewStats {
  transcriptSegments: number;
  questions: number;
  answers: number;
}

export interface CreateInterviewInput {
  mode: InterviewMode;
  context: Partial<InterviewContextDTO>;
}

/** Interview lifecycle: creation, context management, session binding and data purging. */
export class InterviewService {
  constructor(
    private readonly deps: {
      interviews: InterviewRepository;
      transcripts: TranscriptRepository;
      questions: QuestionRepository;
      answers: AnswerRepository;
      metrics: LatencyMetricsService;
      providers: ProviderCatalog;
      ids: IdGenerator;
      now: Clock;
      ttlMs: number;
    },
  ) {}

  create(input: CreateInterviewInput): Interview {
    const availability = this.deps.providers.availability(input.mode);
    if (!availability.available) {
      throw new AppError('LIVE_MODE_UNAVAILABLE', availability.reason ?? 'Mode unavailable', {
        statusCode: 409,
      });
    }
    const interview = Interview.create({
      id: this.deps.ids(),
      mode: input.mode,
      context: InterviewContext.create(input.context),
      now: this.deps.now(),
    });
    this.deps.interviews.save(interview);
    return interview;
  }

  get(id: string): Interview {
    const interview = this.deps.interviews.findById(id);
    if (!interview) throw new NotFoundError('Interview not found', 'INTERVIEW_NOT_FOUND');
    return interview;
  }

  updateContext(id: string, patch: Partial<InterviewContextDTO>): Interview {
    const interview = this.get(id);
    interview.updateContext(patch, this.deps.now());
    this.deps.interviews.save(interview);
    return interview;
  }

  attachSession(id: string, sessionId: string): Interview {
    const interview = this.get(id);
    interview.attachSession(sessionId, this.deps.now());
    this.deps.interviews.save(interview);
    return interview;
  }

  detachSession(id: string, sessionId: string): void {
    const interview = this.deps.interviews.findById(id);
    if (!interview) return;
    interview.detachSession(sessionId, this.deps.now());
    this.deps.interviews.save(interview);
  }

  stats(id: string): InterviewStats {
    return {
      transcriptSegments: this.deps.transcripts.countByInterview(id),
      questions: this.deps.questions.countByInterview(id),
      answers: this.deps.answers.countByInterview(id),
    };
  }

  /** Deletes the interview and every piece of data derived from it (privacy). */
  delete(id: string): void {
    this.get(id);
    this.purge(id);
  }

  /** Removes idle interviews past their TTL. Returns the purged ids. */
  purgeExpired(): string[] {
    const cutoff = this.deps.now() - this.deps.ttlMs;
    const expired = this.deps.interviews.findExpired(cutoff).map((interview) => interview.id);
    expired.forEach((id) => this.purge(id));
    return expired;
  }

  private purge(id: string): void {
    this.deps.interviews.delete(id);
    this.deps.transcripts.deleteByInterview(id);
    this.deps.questions.deleteByInterview(id);
    this.deps.answers.deleteByInterview(id);
    this.deps.metrics.clear(id);
  }
}
