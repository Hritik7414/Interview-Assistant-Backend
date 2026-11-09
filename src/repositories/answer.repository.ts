import type { Answer } from '../mvc/models/answer.model';
import { InterviewScopedStore } from './interview-scoped.store';

export interface AnswerRepository {
  save(answer: Answer): void;
  findById(interviewId: string, id: string): Answer | undefined;
  listByInterview(interviewId: string): readonly Answer[];
  countByInterview(interviewId: string): number;
  deleteByInterview(interviewId: string): void;
}

export class InMemoryAnswerRepository implements AnswerRepository {
  private readonly store: InterviewScopedStore<Answer>;

  constructor(options: { maxPerInterview: number }) {
    this.store = new InterviewScopedStore(options.maxPerInterview);
  }

  save(answer: Answer): void {
    this.store.upsert(answer);
  }

  findById(interviewId: string, id: string): Answer | undefined {
    return this.store.findById(interviewId, id);
  }

  listByInterview(interviewId: string): readonly Answer[] {
    return this.store.list(interviewId);
  }

  countByInterview(interviewId: string): number {
    return this.store.count(interviewId);
  }

  deleteByInterview(interviewId: string): void {
    this.store.deleteByInterview(interviewId);
  }
}
