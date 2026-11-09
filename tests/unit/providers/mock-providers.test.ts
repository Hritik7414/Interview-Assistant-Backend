import { describe, expect, it, vi } from 'vitest';
import { MockLlmProvider, selectCannedAnswer } from '../../../src/providers/llm/mock-llm.provider';
import {
  compileScript,
  DEMO_INTERVIEW_SCRIPT,
  MockTranscriptionProvider,
} from '../../../src/providers/transcription/mock-transcription.provider';
import type {
  TranscriptionResult,
  TranscriptionStreamHandlers,
} from '../../../src/providers/transcription/transcription.interface';
import { analyzeUtterance } from '../../../src/services/question-detection.heuristics';
import { pcm } from '../../helpers/fakes';

const FORMAT = { encoding: 'linear16', sampleRate: 16_000, channels: 1 } as const;

describe('MockTranscriptionProvider', () => {
  async function open(script = [{ pauseBeforeMs: 0, text: 'How would you scale this system?' }]) {
    const results: TranscriptionResult[] = [];
    const handlers: TranscriptionStreamHandlers = {
      onResult: (result) => results.push(result),
      onUtteranceEnd: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
    };
    const provider = new MockTranscriptionProvider({ script, wordDurationMs: 100 });
    const stream = await provider.open({ sessionId: 's', format: FORMAT }, handlers);
    return { provider, stream, results, handlers };
  }

  it('is advertised as simulated', () => {
    expect(new MockTranscriptionProvider().descriptor.simulated).toBe(true);
  });

  it('advances only on received audio (audio clock)', async () => {
    const { stream, results, handlers } = await open();
    expect(results).toHaveLength(0);
    stream.write(pcm(250));
    expect(results.map((r) => r.isFinal)).toEqual([false]);
    stream.write(pcm(2_000));
    expect(results.at(-1)).toMatchObject({
      isFinal: true,
      speechFinal: true,
      text: 'How would you scale this system?',
    });
    expect(handlers.onUtteranceEnd).toHaveBeenCalledOnce();
  });

  it('stops emitting after close', async () => {
    const { stream, results, handlers } = await open();
    await stream.close();
    stream.write(pcm(5_000));
    expect(results).toHaveLength(0);
    expect(handlers.onClose).toHaveBeenCalledWith(expect.objectContaining({ expected: true }));
  });

  it('compiles a time-ordered timeline and honours the speed factor', () => {
    const normal = compileScript(DEMO_INTERVIEW_SCRIPT);
    const fast = compileScript(DEMO_INTERVIEW_SCRIPT, { speed: 2 });
    const times = normal.map((event) => event.atMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(fast.at(-1)!.atMs).toBeCloseTo(normal.at(-1)!.atMs / 2, 5);
  });

  it('demo script contains at least three genuine questions and several statements', () => {
    const verdicts = DEMO_INTERVIEW_SCRIPT.map(
      (line) => analyzeUtterance(line.text, { minWords: 3, confidenceThreshold: 0.5 }).isQuestion,
    );
    expect(verdicts.filter(Boolean).length).toBeGreaterThanOrEqual(3);
    expect(verdicts.filter((isQuestion) => !isQuestion).length).toBeGreaterThanOrEqual(2);
  });
});

describe('MockLlmProvider', () => {
  const request = (signal: AbortSignal, question = 'How would you design a scalable system?') => ({
    messages: [{ role: 'user' as const, content: `<question>\n${question}\n</question>` }],
    maxOutputTokens: 100,
    signal,
  });

  it('streams a canned answer token by token and is labelled simulated', async () => {
    const provider = new MockLlmProvider({ firstTokenDelayMs: 0, tokenDelayMs: 0 });
    expect(provider.descriptor.simulated).toBe(true);
    let text = '';
    let deltas = 0;
    for await (const event of provider.stream(request(new AbortController().signal))) {
      if (event.type === 'delta') {
        text += event.text;
        deltas += 1;
      }
    }
    expect(deltas).toBeGreaterThan(20);
    expect(text).toBe(selectCannedAnswer('design'));
  });

  it('aborts promptly', async () => {
    const provider = new MockLlmProvider({ firstTokenDelayMs: 0, tokenDelayMs: 1_000 });
    const controller = new AbortController();
    const started = Date.now();
    const consume = (async () => {
      for await (const event of provider.stream(request(controller.signal))) {
        if (event.type === 'delta') controller.abort();
      }
    })();
    await expect(consume).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('uses placeholders instead of inventing candidate experience', () => {
    expect(selectCannedAnswer('Tell me about yourself')).toMatch(/\[current title\]/);
    expect(selectCannedAnswer('Something unrelated entirely')).toMatch(/\[project\]/);
  });
});
