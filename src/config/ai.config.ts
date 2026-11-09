import type { Env } from './env.config';

export interface DeepgramConfig {
  apiKey: string | undefined;
  model: string;
  language: string;
  baseUrl: string;
  endpointingMs: number;
  utteranceEndMs: number;
  keepAliveIntervalMs: number;
  connectTimeoutMs: number;
  closeTimeoutMs: number;
}

export interface OpenAiConfig {
  apiKey: string | undefined;
  model: string;
  baseUrl: string | undefined;
  temperature: number | undefined;
  /** Sent as `reasoning_effort` only when set; non-reasoning models reject it. */
  reasoningEffort: Env['OPENAI_REASONING_EFFORT'];
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface QuestionDetectionConfig {
  /** Silence after the last final transcript before an utterance is evaluated. */
  silenceThresholdMs: number;
  minWords: number;
  confidenceThreshold: number;
  /** Questions similar to one asked within this window are treated as duplicates. */
  duplicateWindowMs: number;
  duplicateSimilarity: number;
  maxUtteranceChars: number;
}

export interface AiConfig {
  deepgram: DeepgramConfig;
  openai: OpenAiConfig;
  transcription: {
    maxPendingChunks: number;
    maxReconnectAttempts: number;
    reconnectBaseDelayMs: number;
  };
  answer: {
    maxOutputTokens: number;
    temperature: number | undefined;
    timeoutMs: number;
    recentTranscriptChars: number;
  };
  questionDetection: QuestionDetectionConfig;
  mock: { scriptSpeed: number; tokenDelayMs: number; firstTokenDelayMs: number };
}

export function createAiConfig(env: Env): AiConfig {
  return {
    deepgram: {
      apiKey: env.DEEPGRAM_API_KEY,
      model: env.DEEPGRAM_MODEL,
      language: env.DEEPGRAM_LANGUAGE,
      baseUrl: env.DEEPGRAM_BASE_URL,
      endpointingMs: env.DEEPGRAM_ENDPOINTING_MS,
      utteranceEndMs: env.DEEPGRAM_UTTERANCE_END_MS,
      keepAliveIntervalMs: 4_000,
      connectTimeoutMs: 8_000,
      closeTimeoutMs: 3_000,
    },
    openai: {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      baseUrl: env.OPENAI_BASE_URL,
      temperature: env.OPENAI_TEMPERATURE,
      reasoningEffort: env.OPENAI_REASONING_EFFORT,
      maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS,
      timeoutMs: env.OPENAI_TIMEOUT_MS,
    },
    transcription: {
      // ~5 s of 50 ms frames buffered while a provider stream reconnects.
      maxPendingChunks: 100,
      maxReconnectAttempts: 3,
      reconnectBaseDelayMs: 500,
    },
    answer: {
      maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS,
      temperature: env.OPENAI_TEMPERATURE,
      timeoutMs: env.OPENAI_TIMEOUT_MS,
      recentTranscriptChars: 1_200,
    },
    questionDetection: {
      silenceThresholdMs: env.QUESTION_SILENCE_THRESHOLD_MS,
      minWords: env.QUESTION_MIN_WORDS,
      confidenceThreshold: env.QUESTION_CONFIDENCE_THRESHOLD,
      duplicateWindowMs: 120_000,
      duplicateSimilarity: 0.8,
      maxUtteranceChars: 1_500,
    },
    mock: {
      scriptSpeed: env.MOCK_SCRIPT_SPEED,
      tokenDelayMs: env.MOCK_LLM_TOKEN_DELAY_MS,
      firstTokenDelayMs: env.MOCK_LLM_FIRST_TOKEN_DELAY_MS,
    },
  };
}
