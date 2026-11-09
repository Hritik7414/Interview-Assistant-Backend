import { AUDIO_FRAME_DURATION_MS, createServerEvent, PROTOCOL_VERSION } from '@shared';
import type { AppError } from '../../utils/errors';
import type { SessionInfo, SessionStatusUpdate } from '../../services/interview-session.service';

export function sessionReadyEvent(info: SessionInfo) {
  return createServerEvent('session.ready', info.sessionId, {
    interviewId: info.interviewId,
    resumed: info.resumed,
    mode: info.mode,
    providers: info.providers,
    audio: { ...info.audio, frameDurationMs: AUDIO_FRAME_DURATION_MS },
    detection: { silenceThresholdMs: info.silenceThresholdMs },
    protocolVersion: PROTOCOL_VERSION,
  });
}

export function sessionStatusEvent(
  sessionId: string | null,
  update: SessionStatusUpdate,
  pong?: { clientSentAt: number; serverReceivedAt: number },
) {
  return createServerEvent('session.status', sessionId, {
    state: update.state,
    reason: update.reason,
    ...(update.metrics ? { metrics: update.metrics } : {}),
    ...(update.audio ? { audio: update.audio } : {}),
    ...(pong ? { pong } : {}),
  });
}

export function sessionErrorEvent(sessionId: string | null, error: AppError) {
  return createServerEvent('session.error', sessionId, {
    code: error.code,
    message: error.publicMessage,
    recoverable: error.recoverable,
  });
}
