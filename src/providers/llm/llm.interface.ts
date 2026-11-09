import type { ProviderDescriptor } from '@shared';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletionRequest {
  messages: readonly LlmMessage[];
  maxOutputTokens: number;
  temperature?: number;
  /** Aborting must stop the upstream request and end the stream promptly. */
  signal: AbortSignal;
}

export type LlmStreamEvent =
  { type: 'delta'; text: string } | { type: 'done'; finishReason: 'stop' | 'length' };

/** Contract every LLM vendor adapter implements: token-by-token streaming with cancellation. */
export interface LlmProvider {
  readonly descriptor: ProviderDescriptor;
  stream(request: LlmCompletionRequest): AsyncIterable<LlmStreamEvent>;
}
