import type { ProviderDescriptor } from '@shared';
import OpenAI from 'openai';
import type { OpenAiConfig } from '../../config/ai.config';
import { isAbortError, ProviderError } from '../../utils/errors';
import type { LlmCompletionRequest, LlmProvider, LlmStreamEvent } from './llm.interface';

/** Who serves the configured endpoint: drives the UI label and error messages. */
export interface LlmEndpoint {
  /** Provider name shown in the UI (`openai`, `groq`, `openai-compatible`). */
  name: string;
  /** Human-readable vendor used in error messages. */
  label: string;
}

/**
 * Identifies the vendor behind `OPENAI_BASE_URL` so a Groq (or other
 * OpenAI-compatible) endpoint is never presented to the user as OpenAI.
 */
export function describeLlmEndpoint(baseUrl: string | undefined): LlmEndpoint {
  if (!baseUrl) return { name: 'openai', label: 'OpenAI' };
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // An unparsable URL fails on the first request; label it generically.
  }
  if (host === 'api.openai.com') return { name: 'openai', label: 'OpenAI' };
  if (host === 'groq.com' || host.endsWith('.groq.com')) return { name: 'groq', label: 'Groq' };
  return { name: 'openai-compatible', label: 'the OpenAI-compatible endpoint' };
}

export interface OpenAiProviderOptions {
  /** Injectable fetch — used by adapter tests against a local fake server. */
  fetch?: typeof fetch;
  maxRetries?: number;
}

/** Streams Chat Completions from OpenAI or any OpenAI-compatible endpoint (e.g. Groq). */
export class OpenAiLlmProvider implements LlmProvider {
  readonly descriptor: ProviderDescriptor;
  private readonly endpoint: LlmEndpoint;
  private readonly client: OpenAI;

  constructor(
    private readonly config: OpenAiConfig & { apiKey: string },
    options: OpenAiProviderOptions = {},
  ) {
    this.endpoint = describeLlmEndpoint(config.baseUrl);
    this.descriptor = { name: this.endpoint.name, model: config.model, simulated: false };
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl ?? null,
      timeout: config.timeoutMs,
      // Retrying a realtime answer usually costs more latency than it saves.
      maxRetries: options.maxRetries ?? 1,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async *stream(request: LlmCompletionRequest): AsyncIterable<LlmStreamEvent> {
    let finishReason: 'stop' | 'length' = 'stop';
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: request.messages.map((message) => ({ ...message })),
          stream: true,
          max_completion_tokens: request.maxOutputTokens,
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          // Reasoning models only (e.g. gpt-oss on Groq); other models reject the field.
          ...(this.config.reasoningEffort === undefined
            ? {}
            : { reasoning_effort: this.config.reasoningEffort }),
        },
        { signal: request.signal },
      );

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        // Only the answer text is streamed; reasoning models' hidden reasoning is ignored.
        const text = choice.delta?.content;
        if (text) yield { type: 'delta', text };
        if (choice.finish_reason === 'length') finishReason = 'length';
      }
    } catch (error) {
      throw mapLlmError(error, request.signal, this.endpoint);
    }
    // The SDK ends the iterator silently on abort; surface it explicitly so a
    // cancelled answer is never reported as a normal completion.
    if (request.signal.aborted) {
      throw mapLlmError(new Error('aborted'), request.signal, this.endpoint);
    }
    yield { type: 'done', finishReason };
  }
}

function mapLlmError(error: unknown, signal: AbortSignal, endpoint: LlmEndpoint): Error {
  if (signal.aborted || isAbortError(error) || error instanceof OpenAI.APIUserAbortError) {
    const abort = new Error('LLM request aborted');
    abort.name = 'AbortError';
    return abort;
  }
  if (error instanceof OpenAI.APIError) {
    return new ProviderError(
      'LLM_PROVIDER_ERROR',
      endpoint.name,
      describeStatus(error.status, endpoint.label),
      { cause: error },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(
    'LLM_PROVIDER_ERROR',
    endpoint.name,
    `${capitalize(endpoint.label)} request failed: ${message}`,
    { cause: error },
  );
}

function describeStatus(status: number | undefined, label: string): string {
  const vendor = capitalize(label);
  if (status === undefined) return `Could not reach ${label}`;
  if (status === 401) return `${vendor} rejected the API key (check OPENAI_API_KEY)`;
  if (status === 403) return `${vendor} denied access to the configured model`;
  if (status === 404) return `${vendor} does not have the configured model (check OPENAI_MODEL)`;
  if (status === 413) return `${vendor} rejected the request as too large (shorten the context)`;
  if (status === 429) return `${vendor} rate limit or quota exceeded`;
  if (status === 400) return `${vendor} rejected the request parameters`;
  return `${vendor} returned HTTP ${status}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
