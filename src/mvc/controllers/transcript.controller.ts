import type { TranscriptSegmentDTO } from '@shared';
import type { TranscriptSegment } from '../models/transcript.model';
import type { InterviewService } from '../../services/interview.service';
import type { TranscriptionService } from '../../services/transcription.service';
import type { HandlerResult } from '../../utils/async-handler';
import {
  toTranscriptSegmentDTO,
  transcriptFinalEvent,
  transcriptPartialEvent,
} from '../views/transcript.view';
import type { RealtimeClient } from './controller.types';

export class TranscriptController {
  constructor(
    private readonly deps: { interviews: InterviewService; transcription: TranscriptionService },
  ) {}

  list(interviewId: string): HandlerResult<{ segments: TranscriptSegmentDTO[] }> {
    this.deps.interviews.get(interviewId);
    const segments = this.deps.transcription.getTranscript(interviewId).map(toTranscriptSegmentDTO);
    return { status: 200, body: { segments } };
  }

  presentPartial(client: RealtimeClient, sessionId: string, segment: TranscriptSegment): void {
    client.send(transcriptPartialEvent(sessionId, segment));
  }

  presentFinal(client: RealtimeClient, sessionId: string, segment: TranscriptSegment): void {
    client.send(transcriptFinalEvent(sessionId, segment));
  }
}
