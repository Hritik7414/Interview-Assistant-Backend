import type { Interview } from '../mvc/models/interview.model';

export interface InterviewRepository {
  save(interview: Interview): void;
  findById(id: string): Interview | undefined;
  delete(id: string): boolean;
  /** Idle interviews whose last update is older than `olderThan` (epoch ms). */
  findExpired(olderThan: number): Interview[];
  count(): number;
}

/**
 * In-memory implementation for the POC. Capacity-bounded: when full, the
 * least-recently-updated *idle* interview is evicted; active ones are never evicted.
 */
export class InMemoryInterviewRepository implements InterviewRepository {
  private readonly items = new Map<string, Interview>();

  constructor(private readonly options: { maxEntries: number }) {}

  save(interview: Interview): void {
    if (!this.items.has(interview.id) && this.items.size >= this.options.maxEntries) {
      this.evictOldestIdle();
    }
    this.items.set(interview.id, interview);
  }

  findById(id: string): Interview | undefined {
    return this.items.get(id);
  }

  delete(id: string): boolean {
    return this.items.delete(id);
  }

  findExpired(olderThan: number): Interview[] {
    return [...this.items.values()].filter(
      (interview) => interview.status === 'idle' && interview.updatedAt < olderThan,
    );
  }

  count(): number {
    return this.items.size;
  }

  private evictOldestIdle(): void {
    let oldest: Interview | undefined;
    for (const interview of this.items.values()) {
      if (interview.status !== 'idle') continue;
      if (!oldest || interview.updatedAt < oldest.updatedAt) oldest = interview;
    }
    if (oldest) this.items.delete(oldest.id);
  }
}
