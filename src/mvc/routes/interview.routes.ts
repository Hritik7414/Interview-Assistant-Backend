import { API_PREFIX } from '@shared';
import type { FastifyInstance } from 'fastify';
import { validated } from '../../middleware/validation.middleware';
import { asyncHandler } from '../../utils/async-handler';
import {
  CreateInterviewBodySchema,
  InterviewParamsSchema,
  UpdateContextBodySchema,
} from '../../validators/interview.validator';
import type { AnswerController } from '../controllers/answer.controller';
import type { InterviewController } from '../controllers/interview.controller';
import type { QuestionController } from '../controllers/question.controller';
import type { TranscriptController } from '../controllers/transcript.controller';

export interface InterviewRouteControllers {
  interview: InterviewController;
  transcript: TranscriptController;
  question: QuestionController;
  answer: AnswerController;
}

/** Declarative route table — validation and controller delegation only, no logic. */
export function registerInterviewRoutes(
  app: FastifyInstance,
  controllers: InterviewRouteControllers,
  options: { createPerMinute: number },
): void {
  const { interview, transcript, question, answer } = controllers;
  const base = `${API_PREFIX}/interviews`;
  const byId = { params: InterviewParamsSchema };

  app.get(
    `${API_PREFIX}/capabilities`,
    asyncHandler(() => interview.capabilities()),
  );

  app.post(
    base,
    { config: { rateLimit: { max: options.createPerMinute, timeWindow: 60_000 } } },
    asyncHandler(
      validated({ body: CreateInterviewBodySchema }, ({ body }) => interview.create(body)),
    ),
  );

  app.get(
    `${base}/:interviewId`,
    asyncHandler(validated(byId, ({ params }) => interview.get(params.interviewId))),
  );

  app.patch(
    `${base}/:interviewId/context`,
    asyncHandler(
      validated({ ...byId, body: UpdateContextBodySchema }, ({ params, body }) =>
        interview.updateContext(params.interviewId, body),
      ),
    ),
  );

  app.delete(
    `${base}/:interviewId`,
    asyncHandler(validated(byId, ({ params }) => interview.remove(params.interviewId))),
  );

  app.get(
    `${base}/:interviewId/transcript`,
    asyncHandler(validated(byId, ({ params }) => transcript.list(params.interviewId))),
  );

  app.get(
    `${base}/:interviewId/questions`,
    asyncHandler(validated(byId, ({ params }) => question.list(params.interviewId))),
  );

  app.get(
    `${base}/:interviewId/answers`,
    asyncHandler(validated(byId, ({ params }) => answer.list(params.interviewId))),
  );

  app.get(
    `${base}/:interviewId/metrics`,
    asyncHandler(validated(byId, ({ params }) => interview.metrics(params.interviewId))),
  );
}
