import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().trim().optional());

const integer = (fallback: number, min: number, max: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(fallback));

const decimal = (fallback: number, min: number, max: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().min(min).max(max).default(fallback));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: integer(4000, 0, 65_535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z.preprocess(emptyToUndefined, z.stringbool().optional()),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DEEPGRAM_API_KEY: optionalString,
  DEEPGRAM_MODEL: z.string().default('nova-3'),
  DEEPGRAM_LANGUAGE: z.string().default('en-US'),
  DEEPGRAM_BASE_URL: z.string().default('wss://api.deepgram.com/v1/listen'),
  DEEPGRAM_ENDPOINTING_MS: integer(300, 10, 5_000),
  DEEPGRAM_UTTERANCE_END_MS: integer(1_000, 1_000, 5_000),

  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  OPENAI_BASE_URL: optionalString,
  OPENAI_TEMPERATURE: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(2).optional()),
  /** Reasoning models only (e.g. gpt-oss on Groq: low | medium | high). Sent only when set. */
  OPENAI_REASONING_EFFORT: z.preprocess(
    emptyToUndefined,
    z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  ),
  OPENAI_MAX_OUTPUT_TOKENS: integer(320, 64, 4_000),
  OPENAI_TIMEOUT_MS: integer(20_000, 1_000, 120_000),

  QUESTION_SILENCE_THRESHOLD_MS: integer(1_200, 300, 10_000),
  QUESTION_MIN_WORDS: integer(3, 1, 20),
  QUESTION_CONFIDENCE_THRESHOLD: decimal(0.5, 0, 1),

  SESSION_RESUME_GRACE_MS: integer(30_000, 0, 600_000),
  WS_MAX_CONNECTIONS_PER_IP: integer(5, 1, 1_000),
  RATE_LIMIT_MAX_PER_MINUTE: integer(120, 1, 100_000),

  /** Demo Mode tuning: >1 speeds up the scripted interview (used by E2E tests). */
  MOCK_SCRIPT_SPEED: decimal(1, 0.1, 20),
  MOCK_LLM_TOKEN_DELAY_MS: integer(35, 0, 2_000),
  MOCK_LLM_FIRST_TOKEN_DELAY_MS: integer(350, 0, 10_000),
});

export type Env = z.infer<typeof EnvSchema>;
export type EnvInput = Partial<Record<keyof Env, string | undefined>>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Loads backend settings without overriding process variables. */
export function loadEnvFiles(cwd: string = process.cwd()): string | null {
  if (process.env.NODE_ENV === 'test') return null;
  const candidate = resolve(cwd, '.env');
  if (!existsSync(candidate)) return null;
  process.loadEnvFile(candidate);
  return candidate;
}
