import { createServerEvent, type TranscriptSegmentDTO } from '@shared';
import type { TranscriptSegment } from '../models/transcript.model';

export function toTranscriptSegmentDTO(segment: TranscriptSegment): TranscriptSegmentDTO {
  return {
    id: segment.id,
    text: segment.text,
    isFinal: segment.isFinal,
    startMs: Math.round(segment.startMs),
    endMs: Math.round(segment.endMs),
    confidence: segment.confidence,
    speechFinal: segment.speechFinal,
    receivedAt: segment.receivedAt,
  };
}

export function transcriptPartialEvent(sessionId: string, segment: TranscriptSegment) {
  return createServerEvent('transcript.partial', sessionId, {
    segment: toTranscriptSegmentDTO(segment),
  });
}

export function transcriptFinalEvent(sessionId: string, segment: TranscriptSegment) {
  return createServerEvent('transcript.final', sessionId, {
    segment: toTranscriptSegmentDTO(segment),
  });
}
