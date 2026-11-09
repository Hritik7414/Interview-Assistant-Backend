import { describe, expect, it } from 'vitest';
import { createAiConfig } from '../../../src/config/ai.config';
import { loadEnv } from '../../../src/config/env.config';

describe('environment: OpenAI-compatible LLM settings', () => {
  it('accepts a Groq configuration and maps it into the AI config', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'gsk_test',
      OPENAI_BASE_URL: 'https://api.groq.com/openai/v1',
      OPENAI_MODEL: 'openai/gpt-oss-20b',
      OPENAI_REASONING_EFFORT: 'low',
      OPENAI_MAX_OUTPUT_TOKENS: '1024',
    });
    const { openai } = createAiConfig(env);
    expect(openai).toMatchObject({
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-20b',
      reasoningEffort: 'low',
      maxOutputTokens: 1024,
    });
  });

  it('leaves reasoning effort unset when empty, so it is never sent to non-reasoning models', () => {
    expect(loadEnv({ NODE_ENV: 'test', OPENAI_REASONING_EFFORT: '' }).OPENAI_REASONING_EFFORT).toBe(
      undefined,
    );
    expect(loadEnv({ NODE_ENV: 'test' }).OPENAI_REASONING_EFFORT).toBe(undefined);
  });

  it('rejects an unknown reasoning effort with a clear error', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', OPENAI_REASONING_EFFORT: 'fast' })).toThrow(
      /OPENAI_REASONING_EFFORT/,
    );
  });
});
