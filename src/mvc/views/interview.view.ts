import {
  AUDIO_CHANNELS,
  AUDIO_ENCODING,
  AUDIO_FRAME_DURATION_MS,
  AUDIO_SAMPLE_RATE,
  CONTEXT_LIMITS,
  PROTOCOL_VERSION,
  WS_MAX_MESSAGE_BYTES,
  type CapabilitiesDTO,
  type InterviewSummaryDTO,
} from '@shared';
import type { Interview } from '../models/interview.model';

export interface InterviewStatsView {
  transcriptSegments: number;
  questions: number;
  answers: number;
}

/** Context contents are never echoed back — only their sizes. */
export function toInterviewSummary(
  interview: Interview,
  stats: InterviewStatsView,
): InterviewSummaryDTO {
  return {
    id: interview.id,
    mode: interview.mode,
    status: interview.status,
    activeSessionId: interview.activeSessionId,
    sessionCount: interview.sessionCount,
    createdAt: interview.createdAt,
    updatedAt: interview.updatedAt,
    context: interview.context.characterCounts,
    stats,
  };
}

export function toCapabilitiesDTO(input: {
  modes: CapabilitiesDTO['modes'];
  silenceThresholdMs: number;
}): CapabilitiesDTO {
  return {
    protocolVersion: PROTOCOL_VERSION,
    modes: input.modes,
    audio: {
      encoding: AUDIO_ENCODING,
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
      frameDurationMs: AUDIO_FRAME_DURATION_MS,
    },
    detection: { silenceThresholdMs: input.silenceThresholdMs },
    limits: {
      resumeChars: CONTEXT_LIMITS.resume,
      jobDescriptionChars: CONTEXT_LIMITS.jobDescription,
      instructionsChars: CONTEXT_LIMITS.instructions,
      maxMessageBytes: WS_MAX_MESSAGE_BYTES,
    },
  };
}
