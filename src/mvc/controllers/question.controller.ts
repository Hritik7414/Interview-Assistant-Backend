import type { QuestionDTO } from '@shared';
import type { Question } from '../models/question.model';
import type { InterviewService } from '../../services/interview.service';
import type { QuestionDetectionService } from '../../services/question-detection.service';
import type { HandlerResult } from '../../utils/async-handler';
import { questionDetectedEvent, toQuestionDTO } from '../views/question.view';
import type { RealtimeClient } from './controller.types';

export class QuestionController {
  constructor(
    private readonly deps: { interviews: InterviewService; detection: QuestionDetectionService },
  ) {}

  list(interviewId: string): HandlerResult<{ questions: QuestionDTO[] }> {
    this.deps.interviews.get(interviewId);
    const questions = this.deps.detection.listByInterview(interviewId).map(toQuestionDTO);
    return { status: 200, body: { questions } };
  }

  presentDetected(client: RealtimeClient, sessionId: string, question: Question): void {
    client.send(questionDetectedEvent(sessionId, question));
  }
}
