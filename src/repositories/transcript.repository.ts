import type { TranscriptSegment } from '../mvc/models/transcript.model';
import { InterviewScopedStore } from './interview-scoped.store';

/** Stores *final* transcript segments only; partials are transient. */
export interface TranscriptRepository {
  append(segment: TranscriptSegment): void;
  listByInterview(interviewId: string): readonly TranscriptSegment[];
  recent(interviewId: string, limit: number): TranscriptSegment[];
  countByInterview(interviewId: string): number;
  deleteByInterview(interviewId: string): void;
}

export class InMemoryTranscriptRepository implements TranscriptRepository {
  private readonly store: InterviewScopedStore<TranscriptSegment>;

  constructor(options: { maxPerInterview: number }) {
    this.store = new InterviewScopedStore(options.maxPerInterview);
  }

  append(segment: TranscriptSegment): void {
    this.store.upsert(segment);
  }

  listByInterview(interviewId: string): readonly TranscriptSegment[] {
    return this.store.list(interviewId);
  }

  recent(interviewId: string, limit: number): TranscriptSegment[] {
    return this.store.recent(interviewId, limit);
  }

  countByInterview(interviewId: string): number {
    return this.store.count(interviewId);
  }

  deleteByInterview(interviewId: string): void {
    this.store.deleteByInterview(interviewId);
  }
}
