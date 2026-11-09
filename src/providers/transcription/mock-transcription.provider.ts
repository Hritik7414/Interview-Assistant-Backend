import { pcmBytesToMs, type ProviderDescriptor } from '@shared';
import type {
  TranscriptionProvider,
  TranscriptionResult,
  TranscriptionStream,
  TranscriptionStreamHandlers,
  TranscriptionStreamOptions,
} from './transcription.interface';

export interface MockScriptLine {
  /** Silence before the line starts (ms of audio). */
  pauseBeforeMs: number;
  text: string;
}

/**
 * Scripted interviewer used by Demo Mode. Includes statements that must NOT be
 * detected as questions, fillers ("um", "uh") and four genuine questions.
 */
export const DEMO_INTERVIEW_SCRIPT: readonly MockScriptLine[] = [
  { pauseBeforeMs: 500, text: 'Hi, thanks for joining us today.' },
  {
    pauseBeforeMs: 1_500,
    text: 'Um, so to start, could you walk me through your background and what drew you to this role?',
  },
  { pauseBeforeMs: 14_000, text: "Great, thanks. Let's shift to some technical depth." },
  {
    pauseBeforeMs: 1_600,
    text: 'How would you design a real-time notification system that, uh, needs to scale to millions of users?',
  },
  {
    pauseBeforeMs: 14_000,
    text: 'Tell me about a time you disagreed with a teammate on a technical decision and how you resolved it.',
  },
  {
    pauseBeforeMs: 14_000,
    text: 'Okay. And, um, what is your approach to testing distributed systems?',
  },
  {
    pauseBeforeMs: 14_000,
    text: "That's everything from my side. Thanks so much for your time today.",
  },
];

export interface MockTranscriptionOptions {
  script?: readonly MockScriptLine[];
  /** >1 compresses the script timeline (e.g. 3 = three times faster). */
  speed?: number;
  wordDurationMs?: number;
  partialEveryWords?: number;
  maxWordsPerFinal?: number;
  finalizationDelayMs?: number;
  utteranceEndDelayMs?: number;
}

type TimelineEvent =
  | { atMs: number; kind: 'result'; result: TranscriptionResult }
  | { atMs: number; kind: 'utterance-end'; lastWordEndMs: number }
  | { atMs: number; kind: 'speech-started' };

/**
 * Simulated STT. The script advances on the **audio clock** — the amount of
 * audio actually received — so Demo Mode exercises the full capture → WebSocket
 * → ingestion path. No audio, no transcript.
 */
export class MockTranscriptionProvider implements TranscriptionProvider {
  readonly descriptor: ProviderDescriptor = {
    name: 'mock-transcription',
    model: 'scripted-demo',
    simulated: true,
  };

  private readonly timeline: readonly TimelineEvent[];

  constructor(options: MockTranscriptionOptions = {}) {
    this.timeline = compileScript(options.script ?? DEMO_INTERVIEW_SCRIPT, options);
  }

  async open(
    options: TranscriptionStreamOptions,
    handlers: TranscriptionStreamHandlers,
  ): Promise<TranscriptionStream> {
    return new MockTranscriptionStream(this.timeline, handlers, options.format.sampleRate);
  }

  /** Total scripted duration in audio ms (useful for tests). */
  get durationMs(): number {
    return this.timeline.at(-1)?.atMs ?? 0;
  }
}

class MockTranscriptionStream implements TranscriptionStream {
  private audioMs = 0;
  private cursor = 0;
  private closed = false;

  constructor(
    private readonly timeline: readonly TimelineEvent[],
    private readonly handlers: TranscriptionStreamHandlers,
    private readonly sampleRate: number,
  ) {}

  write(pcm: Uint8Array): void {
    if (this.closed) return;
    this.audioMs += pcmBytesToMs(pcm.byteLength, this.sampleRate);
    while (this.cursor < this.timeline.length) {
      const event = this.timeline[this.cursor];
      if (!event || event.atMs > this.audioMs) break;
      this.cursor += 1;
      this.emit(event);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose({ code: 1000, reason: 'closed', expected: true });
  }

  private emit(event: TimelineEvent): void {
    switch (event.kind) {
      case 'result':
        this.handlers.onResult(event.result);
        break;
      case 'utterance-end':
        this.handlers.onUtteranceEnd({ lastWordEndMs: event.lastWordEndMs });
        break;
      case 'speech-started':
        this.handlers.onSpeechStarted?.();
        break;
    }
  }
}

/** Expands script lines into a sorted timeline of partial/final/utterance-end events. */
export function compileScript(
  script: readonly MockScriptLine[],
  options: MockTranscriptionOptions = {},
): TimelineEvent[] {
  const speed = options.speed ?? 1;
  const wordMs = (options.wordDurationMs ?? 300) / speed;
  const partialEvery = Math.max(1, options.partialEveryWords ?? 2);
  const maxWordsPerFinal = Math.max(2, options.maxWordsPerFinal ?? 14);
  const finalizeMs = (options.finalizationDelayMs ?? 120) / speed;
  const utteranceEndMs = (options.utteranceEndDelayMs ?? 1_000) / speed;

  const events: TimelineEvent[] = [];
  let cursor = 0;

  for (const line of script) {
    cursor += line.pauseBeforeMs / speed;
    events.push({ atMs: cursor + wordMs / 2, kind: 'speech-started' });
    const chunks = chunkWords(line.text.split(/\s+/).filter(Boolean), maxWordsPerFinal);

    chunks.forEach((words, chunkIndex) => {
      const chunkStart = cursor;
      words.forEach((_, wordIndex) => {
        cursor += wordMs;
        const spoken = wordIndex + 1;
        if (spoken % partialEvery === 0 && spoken < words.length) {
          events.push({
            atMs: cursor,
            kind: 'result',
            result: result(words.slice(0, spoken).join(' '), chunkStart, cursor, false, false),
          });
        }
      });
      const isLastChunk = chunkIndex === chunks.length - 1;
      events.push({
        atMs: cursor + finalizeMs,
        kind: 'result',
        result: result(words.join(' '), chunkStart, cursor, true, isLastChunk),
      });
    });

    events.push({ atMs: cursor + utteranceEndMs, kind: 'utterance-end', lastWordEndMs: cursor });
  }

  return events.sort((a, b) => a.atMs - b.atMs);
}

function result(
  text: string,
  startMs: number,
  endMs: number,
  isFinal: boolean,
  speechFinal: boolean,
): TranscriptionResult {
  return { text, startMs, endMs, isFinal, speechFinal, confidence: isFinal ? 0.97 : 0.82 };
}

/** Splits words into final-sized chunks, preferring sentence boundaries. */
function chunkWords(words: string[], maxWords: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const word of words) {
    current.push(word);
    const sentenceEnd = /[.?!]$/.test(word) && current.length >= 4;
    if (sentenceEnd || current.length >= maxWords) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
