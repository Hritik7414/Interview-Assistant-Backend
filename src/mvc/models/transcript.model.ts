import { clampUnit } from './numbers';
import { countWords, normalizeText } from './text';

export interface TranscriptSegmentProps {
  id: string;
  interviewId: string;
  sessionId: string;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
  confidence: number;
  speechFinal: boolean;
  receivedAt: number;
}

/** One transcript fragment. Times are audio offsets (ms) from the start of the session stream. */
export class TranscriptSegment {
  readonly id: string;
  readonly interviewId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly isFinal: boolean;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence: number;
  readonly speechFinal: boolean;
  readonly receivedAt: number;

  private constructor(props: TranscriptSegmentProps) {
    this.id = props.id;
    this.interviewId = props.interviewId;
    this.sessionId = props.sessionId;
    this.text = props.text;
    this.isFinal = props.isFinal;
    this.startMs = props.startMs;
    this.endMs = props.endMs;
    this.confidence = props.confidence;
    this.speechFinal = props.speechFinal;
    this.receivedAt = props.receivedAt;
  }

  /** Normalises provider quirks: trims text, orders/clamps times, bounds confidence. */
  static create(props: TranscriptSegmentProps): TranscriptSegment {
    const startMs = Math.max(0, Math.min(props.startMs, props.endMs));
    const endMs = Math.max(0, props.startMs, props.endMs);
    return new TranscriptSegment({
      ...props,
      text: props.text.trim().replace(/\s+/g, ' '),
      startMs,
      endMs,
      confidence: clampUnit(props.confidence),
      speechFinal: props.isFinal && props.speechFinal,
    });
  }

  get normalizedText(): string {
    return normalizeText(this.text);
  }

  get wordCount(): number {
    return countWords(this.text);
  }

  get durationMs(): number {
    return this.endMs - this.startMs;
  }

  /** Fraction of the shorter segment covered by the overlap with `other`. */
  overlapRatio(other: TranscriptSegment): number {
    const overlap = Math.min(this.endMs, other.endMs) - Math.max(this.startMs, other.startMs);
    if (overlap <= 0) return 0;
    const shortest = Math.min(this.durationMs, other.durationMs);
    return shortest <= 0 ? 1 : Math.min(1, overlap / shortest);
  }
}

/**
 * A final segment is a duplicate when a recent final has the same normalised text
 * and covers (most of) the same audio — e.g. a provider replay after reconnect.
 */
export function isDuplicateSegment(
  candidate: TranscriptSegment,
  recent: readonly TranscriptSegment[],
): boolean {
  const text = candidate.normalizedText;
  return recent.some(
    (segment) =>
      segment.isFinal &&
      segment.normalizedText === text &&
      (segment.overlapRatio(candidate) >= 0.5 ||
        (segment.startMs === candidate.startMs && segment.endMs === candidate.endMs)),
  );
}

export function joinSegmentText(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((segment) => segment.text)
    .filter(Boolean)
    .join(' ')
    .trim();
}

/** Most recent transcript text, truncated at a word boundary to at most `maxChars`. */
export function recentTranscriptText(
  segments: readonly TranscriptSegment[],
  maxChars: number,
): string {
  const full = joinSegmentText(segments);
  if (full.length <= maxChars) return full;
  const tail = full.slice(full.length - maxChars);
  const firstSpace = tail.indexOf(' ');
  return `…${firstSpace === -1 ? tail : tail.slice(firstSpace + 1)}`;
}
