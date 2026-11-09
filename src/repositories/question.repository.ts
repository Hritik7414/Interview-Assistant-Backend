import type { Question } from '../mvc/models/question.model';
import { InterviewScopedStore } from './interview-scoped.store';

export interface QuestionRepository {
  save(question: Question): void;
  findById(interviewId: string, id: string): Question | undefined;
  listByInterview(interviewId: string): readonly Question[];
  recent(interviewId: string, limit: number): Question[];
  countByInterview(interviewId: string): number;
  deleteByInterview(interviewId: string): void;
}

export class InMemoryQuestionRepository implements QuestionRepository {
  private readonly store: InterviewScopedStore<Question>;

  constructor(options: { maxPerInterview: number }) {
    this.store = new InterviewScopedStore(options.maxPerInterview);
  }

  save(question: Question): void {
    this.store.upsert(question);
  }

  findById(interviewId: string, id: string): Question | undefined {
    return this.store.findById(interviewId, id);
  }

  listByInterview(interviewId: string): readonly Question[] {
    return this.store.list(interviewId);
  }

  recent(interviewId: string, limit: number): Question[] {
    return this.store.recent(interviewId, limit);
  }

  countByInterview(interviewId: string): number {
    return this.store.count(interviewId);
  }

  deleteByInterview(interviewId: string): void {
    this.store.deleteByInterview(interviewId);
  }
}
