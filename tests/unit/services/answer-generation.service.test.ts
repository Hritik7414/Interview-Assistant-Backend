import { describe, expect, it, vi } from 'vitest';
import type { Answer } from '../../../src/mvc/models/answer.model';
import { InMemoryAnswerRepository } from '../../../src/repositories/answer.repository';
import {
  AnswerGenerationService,
  type AnswerStreamHandlers,
} from '../../../src/services/answer-generation.service';
import { LatencyMetricsService } from '../../../src/services/latency-metrics.service';
import { ProviderError } from '../../../src/utils/errors';
import { createSilentLogger } from '../../../src/utils/logger';
import { ScriptedLlmProvider, type ScriptedLlmOptions } from '../../helpers/fakes';
import { INTERVIEW_ID, makeInterview, makeQuestion, SESSION_ID } from '../../helpers/factories';

function setup(timeoutMs = 5_000) {
  let id = 0;
  const metrics = new LatencyMetricsService();
  const repository = new InMemoryAnswerRepository({ maxPerInterview: 10 });
  const service = new AnswerGenerationService({
    answers: repository,
    metrics,
    config: { maxOutputTokens: 200, temperature: 0.3, timeoutMs, recentTranscriptChars: 500 },
    logger: createSilentLogger(),
    ids: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    now: () => Date.now(),
  });
  const deltas: string[] = [];
  const completed: Answer[] = [];
  const handlers: AnswerStreamHandlers = {
    onStarted: vi.fn(),
    onDelta: (_answer, delta) => deltas.push(delta),
    onCompleted: (answer) => completed.push(answer),
  };
  const generate = (
    llmOptions: ScriptedLlmOptions = {},
    question = makeQuestion('How do you test code?'),
  ) => {
    const llm = new ScriptedLlmProvider(llmOptions);
    const promise = service.generate({
      sessionId: SESSION_ID,
      interview: makeInterview({
        resume: 'Built payment systems at Acme',
        jobDescription: 'Senior engineer',
      }),
      question,
      recentTranscript: 'Interviewer: hello',
      llm,
      handlers,
    });
    return { llm, promise, question };
  };
  return { service, metrics, repository, handlers, deltas, completed, generate };
}

describe('AnswerGenerationService', () => {
  it('streams deltas token by token and completes the answer', async () => {
    const ctx = setup();
    const { promise, question, llm } = ctx.generate({ tokens: ['- A ', 'B.\n', '- C.'] });
    const answer = await promise;

    expect(ctx.handlers.onStarted).toHaveBeenCalledOnce();
    expect(ctx.deltas).toEqual(['- A ', 'B.\n', '- C.']);
    expect(answer.status).toBe('completed');
    expect(answer.text).toBe('- A B.\n- C.');
    expect(question.status).toBe('answered');
    expect(ctx.completed).toEqual([answer]);
    expect(ctx.repository.findById(INTERVIEW_ID, answer.id)?.status).toBe('completed');

    // Context reaches the provider, together with token limit and temperature.
    const request = llm.requests[0]!;
    expect(request.maxOutputTokens).toBe(200);
    expect(request.temperature).toBe(0.3);
    expect(request.messages.at(-1)!.content).toContain('Built payment systems at Acme');
    expect(request.messages.at(-1)!.content).toContain(
      '<question>\nHow do you test code?\n</question>',
    );
  });

  it('records first-token, end-to-end and total latency', async () => {
    const ctx = setup();
    await ctx.generate().promise;
    const snapshot = ctx.metrics.snapshot(INTERVIEW_ID);
    expect(snapshot.llmFirstToken?.count).toBe(1);
    expect(snapshot.endToEnd?.count).toBe(1);
    expect(snapshot.answerTotal?.count).toBe(1);
  });

  it('cancels the in-flight answer when a newer question arrives', async () => {
    const ctx = setup();
    const first = ctx.generate({ hang: true }, makeQuestion('First question here?'));
    await vi.waitFor(() => expect(ctx.deltas.length).toBeGreaterThan(0));
    const second = ctx.generate({}, makeQuestion('Second question here?'));

    const [firstAnswer, secondAnswer] = await Promise.all([first.promise, second.promise]);
    expect(firstAnswer.status).toBe('cancelled');
    expect(firstAnswer.finishReason).toBe('cancelled');
    expect(first.question.status).toBe('cancelled');
    expect(secondAnswer.status).toBe('completed');
  });

  it('supports explicit cancellation via AbortController', async () => {
    const ctx = setup();
    const { promise, llm } = ctx.generate({ hang: true });
    await vi.waitFor(() => expect(ctx.service.isGenerating(SESSION_ID)).toBe(true));
    expect(ctx.service.cancel(SESSION_ID, 'client_cancelled', 'wrong-id')).toBe(false);
    expect(ctx.service.cancel(SESSION_ID, 'client_cancelled')).toBe(true);
    const answer = await promise;
    expect(answer.status).toBe('cancelled');
    expect(llm.requests[0]!.signal.aborted).toBe(true);
    expect(ctx.service.isGenerating(SESSION_ID)).toBe(false);
  });

  it('fails the answer when the provider errors', async () => {
    const ctx = setup();
    const answer = await ctx.generate({
      failWith: new ProviderError(
        'LLM_PROVIDER_ERROR',
        'scripted',
        'OpenAI rate limit or quota exceeded',
      ),
    }).promise;
    expect(answer.status).toBe('failed');
    expect(answer.errorMessage).toBe('OpenAI rate limit or quota exceeded');
    expect(ctx.completed).toHaveLength(1);
  });

  it('fails the answer when it exceeds the timeout', async () => {
    const ctx = setup(50);
    const answer = await ctx.generate({ hang: true }).promise;
    expect(answer.status).toBe('failed');
    expect(answer.errorMessage).toMatch(/too long/);
  });

  it('propagates the provider finish reason', async () => {
    const ctx = setup();
    const answer = await ctx.generate({ finishReason: 'length' }).promise;
    expect(answer.finishReason).toBe('length');
  });
});
