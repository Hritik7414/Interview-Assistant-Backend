/**
 * Bounded, interview-scoped in-memory collection shared by the transcript,
 * question and answer repositories. Oldest entries are evicted first so a
 * long-running session can never grow memory without bound.
 */
export class InterviewScopedStore<TEntity extends { id: string; interviewId: string }> {
  private readonly byInterview = new Map<string, TEntity[]>();

  constructor(private readonly maxPerInterview: number) {}

  /** Inserts or replaces (by id) an entity. */
  upsert(entity: TEntity): void {
    const list = this.byInterview.get(entity.interviewId) ?? [];
    const index = list.findIndex((item) => item.id === entity.id);
    if (index >= 0) {
      list[index] = entity;
    } else {
      list.push(entity);
      if (list.length > this.maxPerInterview) list.splice(0, list.length - this.maxPerInterview);
    }
    this.byInterview.set(entity.interviewId, list);
  }

  findById(interviewId: string, id: string): TEntity | undefined {
    return this.byInterview.get(interviewId)?.find((item) => item.id === id);
  }

  list(interviewId: string): readonly TEntity[] {
    return this.byInterview.get(interviewId) ?? [];
  }

  recent(interviewId: string, limit: number): TEntity[] {
    const list = this.byInterview.get(interviewId) ?? [];
    return list.slice(Math.max(0, list.length - limit));
  }

  count(interviewId: string): number {
    return this.byInterview.get(interviewId)?.length ?? 0;
  }

  deleteByInterview(interviewId: string): void {
    this.byInterview.delete(interviewId);
  }
}
