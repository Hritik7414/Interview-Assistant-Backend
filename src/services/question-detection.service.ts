import type { QuestionDetectionConfig } from '../config/ai.config';
import { Question } from '../mvc/models/question.model';
import { joinSegmentText, type TranscriptSegment } from '../mvc/models/transcript.model';
import type { QuestionRepository } from '../repositories/question.repository';
import type { Logger } from '../utils/logger';
import type { Clock, IdGenerator } from '../utils/runtime';
import { analyzeUtterance, endsWithQuestionMark } from './question-detection.heuristics';
import type { LatencyMetricsService } from './latency-metrics.service';

export type DetectionTrigger = 'silence' | 'utterance-end' | 'speech-final' | 'audio-gap' | 'flush';

export interface DetectorParams {
  sessionId: string;
  interviewId: string;
  onQuestion(question: Question): void;
}

export interface QuestionDetectionDeps {
  config: QuestionDetectionConfig;
  questions: QuestionRepository;
  metrics: LatencyMetricsService;
  logger: Logger;
  ids: IdGenerator;
  now: Clock;
}

/**
 * Factory for per-session detectors. Detection combines provider pause signals
 * (utterance end / endpointing), a configurable wall-clock silence timer and
 * audio-time gaps between final segments, then applies linguistic heuristics,
 * minimum-length rules and duplicate suppression.
 */
export class QuestionDetectionService {
  constructor(private readonly deps: QuestionDetectionDeps) {}

  get config(): QuestionDetectionConfig {
    return this.deps.config;
  }

  createDetector(params: DetectorParams): QuestionDetector {
    return new QuestionDetector(params, this.deps);
  }

  listByInterview(interviewId: string): readonly Question[] {
    return this.deps.questions.listByInterview(interviewId);
  }
}

export class QuestionDetector {
  private pending: TranscriptSegment[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly params: DetectorParams,
    private readonly deps: QuestionDetectionDeps,
  ) {}

  /** Interim speech means the speaker is still talking: postpone the silence timer. */
  notePartial(segment: TranscriptSegment): void {
    if (this.disposed || segment.text === '' || this.pending.length === 0) return;
    this.armSilenceTimer();
  }

  addFinal(segment: TranscriptSegment): void {
    if (this.disposed) return;
    const last = this.pending.at(-1);
    if (last && segment.startMs - last.endMs >= this.deps.config.silenceThresholdMs) {
      // A long audio gap separates two utterances even if no pause signal arrived.
      this.evaluate('audio-gap');
    }
    this.pending.push(segment);
    this.trimPending();

    if (segment.speechFinal && endsWithQuestionMark(segment.text)) {
      // Fast path: the provider saw end-of-speech and the sentence is clearly a question.
      this.evaluate('speech-final');
      return;
    }
    this.armSilenceTimer();
  }

  onUtteranceEnd(): void {
    if (this.disposed) return;
    this.evaluate('utterance-end');
  }

  /** Evaluates whatever is pending immediately (e.g. when the session stops). */
  flush(): void {
    if (!this.disposed) this.evaluate('flush');
  }

  /** Discards pending text without evaluating it (e.g. when the transport drops). */
  reset(): void {
    this.clearTimer();
    this.pending = [];
  }

  dispose(): void {
    this.reset();
    this.disposed = true;
  }

  private evaluate(trigger: DetectionTrigger): void {
    this.clearTimer();
    if (this.pending.length === 0) return;
    const segments = this.pending;
    this.pending = [];

    const { config, logger } = this.deps;
    const analysis = analyzeUtterance(joinSegmentText(segments), config);
    if (!analysis.isQuestion) {
      logger.debug(
        { trigger, rejection: analysis.rejection, confidence: analysis.confidence },
        'Utterance not treated as a question',
      );
      return;
    }
    if (this.isDuplicate(analysis.questionText)) {
      logger.debug({ trigger }, 'Duplicate question suppressed');
      return;
    }

    const lastSegment = segments[segments.length - 1]!;
    const question = Question.create({
      id: this.deps.ids(),
      interviewId: this.params.interviewId,
      sessionId: this.params.sessionId,
      text: analysis.questionText,
      confidence: analysis.confidence,
      reasons: [...analysis.reasons, `trigger:${trigger}`],
      sourceSegmentIds: segments.map((segment) => segment.id),
      utteranceEndedAt: lastSegment.receivedAt,
      detectedAt: this.deps.now(),
    });
    this.deps.questions.save(question);
    this.deps.metrics.record(
      this.params.interviewId,
      'questionDetection',
      question.detectionLatencyMs,
    );
    this.params.onQuestion(question);
  }

  private isDuplicate(text: string): boolean {
    const { duplicateWindowMs, duplicateSimilarity } = this.deps.config;
    const cutoff = this.deps.now() - duplicateWindowMs;
    return this.deps.questions
      .recent(this.params.interviewId, 10)
      .some(
        (previous) =>
          previous.detectedAt >= cutoff && previous.similarityTo(text) >= duplicateSimilarity,
      );
  }

  private trimPending(): void {
    let total = this.pending.reduce((sum, segment) => sum + segment.text.length, 0);
    while (total > this.deps.config.maxUtteranceChars && this.pending.length > 1) {
      total -= this.pending.shift()!.text.length;
    }
  }

  private armSilenceTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.evaluate('silence'), this.deps.config.silenceThresholdMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
