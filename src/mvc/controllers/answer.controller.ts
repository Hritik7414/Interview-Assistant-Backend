import type { AnswerCancelEvent, AnswerDTO } from '@shared';
import type { Answer } from '../models/answer.model';
import type { AnswerGenerationService } from '../../services/answer-generation.service';
import type { InterviewService } from '../../services/interview.service';
import type { InterviewSessionService } from '../../services/interview-session.service';
import type { HandlerResult } from '../../utils/async-handler';
import { NotFoundError } from '../../utils/errors';
import {
  answerCompletedEvent,
  answerDeltaEvent,
  answerStartedEvent,
  toAnswerDTO,
} from '../views/answer.view';
import type { RealtimeClient, RealtimeContext } from './controller.types';

export class AnswerController {
  constructor(
    private readonly deps: {
      interviews: InterviewService;
      answers: AnswerGenerationService;
      sessions: InterviewSessionService;
    },
  ) {}

  list(interviewId: string): HandlerResult<{ answers: AnswerDTO[] }> {
    this.deps.interviews.get(interviewId);
    const answers = this.deps.answers.listByInterview(interviewId).map(toAnswerDTO);
    return { status: 200, body: { answers } };
  }

  /** Cancels the in-flight answer; the stream then ends with `answer.completed` (cancelled). */
  cancel(context: RealtimeContext, payload: AnswerCancelEvent['payload']): boolean {
    if (!context.sessionId || context.sessionId !== payload.sessionId) {
      throw new NotFoundError(
        'No active session with that id on this connection',
        'SESSION_NOT_FOUND',
      );
    }
    return this.deps.sessions.cancelAnswer(context.sessionId, payload.answerId);
  }

  presentStarted(client: RealtimeClient, sessionId: string, answer: Answer): void {
    client.send(answerStartedEvent(sessionId, answer));
  }

  presentDelta(
    client: RealtimeClient,
    sessionId: string,
    answer: Answer,
    delta: string,
    index: number,
  ): void {
    client.send(answerDeltaEvent(sessionId, answer, delta, index));
  }

  presentCompleted(client: RealtimeClient, sessionId: string, answer: Answer): void {
    client.send(answerCompletedEvent(sessionId, answer));
  }
}
