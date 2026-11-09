import type { AudioChunkEvent } from '@shared';
import type { AudioIngestOutcome } from '../../services/audio-stream.service';
import type { InterviewSessionService } from '../../services/interview-session.service';
import { AppError } from '../../utils/errors';
import type { RealtimeContext } from './controller.types';

/** Accepts decoded `audio.chunk` frames for the session bound to the connection. */
export class AudioController {
  constructor(private readonly deps: { sessions: InterviewSessionService }) {}

  handleChunk(context: RealtimeContext, frame: AudioChunkEvent): AudioIngestOutcome {
    if (!context.sessionId) {
      throw new AppError('SESSION_NOT_STARTED', 'Send session.start before streaming audio', {
        statusCode: 409,
      });
    }
    return this.deps.sessions.ingestAudio(context.sessionId, frame);
  }
}
