import { Answer } from '../mvc/models/answer.model';
import type { Interview } from '../mvc/models/interview.model';
import type { Question } from '../mvc/models/question.model';
import type { LlmProvider } from '../providers/llm/llm.interface';
import type { AnswerRepository } from '../repositories/answer.repository';
import { isAbortError, toAppError } from '../utils/errors';
import type { Logger } from '../utils/logger';
import type { Clock, IdGenerator } from '../utils/runtime';
import { buildAnswerMessages } from './answer-prompt.builder';
import type { LatencyMetricsService } from './latency-metrics.service';

export interface AnswerGenerationConfig {
  maxOutputTokens: number;
  temperature: number | undefined;
  timeoutMs: number;
  recentTranscriptChars: number;
}

export interface AnswerStreamHandlers {
  onStarted(answer: Answer): void;
  onDelta(answer: Answer, delta: string, index: number): void;
  onCompleted(answer: Answer): void;
}

export interface GenerateAnswerParams {
  sessionId: string;
  interview: Interview;
  question: Question;
  recentTranscript: string;
  llm: LlmProvider;
  handlers: AnswerStreamHandlers;
}

export type CancelReason =
  'superseded' | 'client_cancelled' | 'session_stopped' | 'session_suspended';

interface InFlightAnswer {
  answer: Answer;
  controller: AbortController;
}

/**
 * Streams one answer per session at a time. A newer question supersedes (aborts)
 * the in-flight answer; every request carries an AbortSignal combining manual
 * cancellation and a hard timeout so upstream requests never leak.
 */
export class AnswerGenerationService {
  private readonly inFlight = new Map<string, InFlightAnswer>();

  constructor(
    private readonly deps: {
      answers: AnswerRepository;
      metrics: LatencyMetricsService;
      config: AnswerGenerationConfig;
      logger: Logger;
      ids: IdGenerator;
      now: Clock;
    },
  ) {}

  async generate(params: GenerateAnswerParams): Promise<Answer> {
    const { sessionId, interview, question, llm, handlers } = params;
    const { config, metrics, now } = this.deps;
    this.cancel(sessionId, 'superseded');

    const answer = Answer.create({
      id: this.deps.ids(),
      questionId: question.id,
      interviewId: interview.id,
      sessionId,
      provider: llm.descriptor,
      startedAt: now(),
    });
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = AbortSignal.any([controller.signal, timeout]);
    this.inFlight.set(sessionId, { answer, controller });

    question.markAnswering();
    this.deps.answers.save(answer);
    handlers.onStarted(answer);

    let finishReason: 'stop' | 'length' = 'stop';
    try {
      const messages = buildAnswerMessages({
        context: interview.context,
        question: question.text,
        recentTranscript: params.recentTranscript,
      });
      for await (const event of llm.stream({
        messages,
        maxOutputTokens: config.maxOutputTokens,
        ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
        signal,
      })) {
        if (signal.aborted) break;
        if (event.type === 'done') {
          finishReason = event.finishReason;
          continue;
        }
        if (event.text === '') continue;
        const at = now();
        const index = answer.appendDelta(event.text, at);
        if (index === 0) {
          metrics.record(interview.id, 'llmFirstToken', at - answer.startedAt);
          metrics.record(interview.id, 'endToEnd', at - question.utteranceEndedAt);
        }
        handlers.onDelta(answer, event.text, index);
      }
      this.settle(answer, question, signal, timeout, finishReason);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        this.settle(answer, question, signal, timeout, finishReason);
      } else {
        const appError = toAppError(error);
        this.deps.logger.warn(
          { err: error, sessionId, provider: llm.descriptor.name },
          'Answer generation failed',
        );
        answer.fail(appError.publicMessage, now());
        question.markFailed();
      }
    } finally {
      if (this.inFlight.get(sessionId)?.answer === answer) this.inFlight.delete(sessionId);
      this.deps.answers.save(answer);
      if (answer.totalLatencyMs !== null && answer.status === 'completed') {
        metrics.record(interview.id, 'answerTotal', answer.totalLatencyMs);
      }
      handlers.onCompleted(answer);
    }
    return answer;
  }

  /** Aborts the in-flight answer of a session (optionally only if it matches `answerId`). */
  cancel(sessionId: string, reason: CancelReason, answerId?: string): boolean {
    const entry = this.inFlight.get(sessionId);
    if (!entry || (answerId !== undefined && entry.answer.id !== answerId)) return false;
    this.inFlight.delete(sessionId);
    entry.controller.abort(new Error(reason));
    return true;
  }

  cancelAll(reason: CancelReason): void {
    for (const sessionId of [...this.inFlight.keys()]) this.cancel(sessionId, reason);
  }

  isGenerating(sessionId: string): boolean {
    return this.inFlight.has(sessionId);
  }

  listByInterview(interviewId: string): readonly Answer[] {
    return this.deps.answers.listByInterview(interviewId);
  }

  private settle(
    answer: Answer,
    question: Question,
    signal: AbortSignal,
    timeout: AbortSignal,
    finishReason: 'stop' | 'length',
  ): void {
    const at = this.deps.now();
    if (timeout.aborted) {
      answer.fail('The answer took too long and was stopped', at);
      question.markFailed();
    } else if (signal.aborted) {
      answer.cancel(at);
      question.markCancelled();
    } else {
      answer.complete(finishReason, at);
      question.markAnswered();
    }
  }
}
