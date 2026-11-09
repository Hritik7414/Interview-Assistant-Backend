import type { AddressInfo } from 'node:net';
import { buildApp, type BuildAppOptions } from '../../src/app';
import { loadEnv } from '../../src/config/env.config';
import { MockLlmProvider } from '../../src/providers/llm/mock-llm.provider';
import { ProviderRegistry, type ProviderCatalog } from '../../src/providers/provider.registry';
import {
  MockTranscriptionProvider,
  type MockScriptLine,
} from '../../src/providers/transcription/mock-transcription.provider';
import { createSilentLogger } from '../../src/utils/logger';

/**
 * Short interview script: one statement (must be ignored) and two questions.
 * Audio timeline at 100 ms/word: Q1 ends ≈ 2.0 s, Q2 utterance-end ≈ 6.9 s.
 */
export const TEST_SCRIPT: readonly MockScriptLine[] = [
  { pauseBeforeMs: 100, text: 'Thanks for joining today.' },
  { pauseBeforeMs: 500, text: 'How would you design a rate limiter for a public API?' },
  { pauseBeforeMs: 3_000, text: 'Tell me about a time you improved system reliability.' },
];

export function createTestProviders(): ProviderRegistry {
  return new ProviderRegistry({
    demo: {
      transcription: new MockTranscriptionProvider({ script: TEST_SCRIPT, wordDurationMs: 100 }),
      llm: new MockLlmProvider({ firstTokenDelayMs: 20, tokenDelayMs: 2 }),
    },
    live: null,
  });
}

export interface TestApp {
  app: Awaited<ReturnType<typeof buildApp>>['app'];
  container: Awaited<ReturnType<typeof buildApp>>['container'];
  baseUrl: string;
  wsUrl: string;
  close(): Promise<void>;
}

export async function startTestApp(
  options: {
    env?: Record<string, string>;
    providers?: ProviderCatalog;
    configure?: BuildAppOptions['configure'];
  } = {},
): Promise<TestApp> {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    CORS_ORIGINS: 'http://localhost:3000',
    QUESTION_SILENCE_THRESHOLD_MS: '400',
    SESSION_RESUME_GRACE_MS: '2000',
    ...options.env,
  });
  const { app, container } = await buildApp({
    env,
    logger: createSilentLogger(),
    providers: options.providers ?? createTestProviders(),
    ...(options.configure ? { configure: options.configure } : {}),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return {
    app,
    container,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    close: () => app.close(),
  };
}

export async function createInterview(
  baseUrl: string,
  body: Record<string, unknown> = { mode: 'demo', context: { resume: 'Senior backend engineer.' } },
): Promise<{ id: string }> {
  const response = await fetch(`${baseUrl}/api/v1/interviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status !== 201) throw new Error(`Create failed: ${response.status}`);
  const json = (await response.json()) as { interview: { id: string } };
  return json.interview;
}

export const AUDIO_FORMAT = { encoding: 'linear16', sampleRate: 16_000, channels: 1 } as const;

/** Test-only JSON reader: response bodies are asserted structurally by each test. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJson(response: Response): Promise<any> {
  return response.json();
}
