import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { OpenAiConfig } from '../../../src/config/ai.config';
import { describeLlmEndpoint, OpenAiLlmProvider } from '../../../src/providers/llm/openai.provider';
import type { LlmStreamEvent } from '../../../src/providers/llm/llm.interface';
import { ProviderError } from '../../../src/utils/errors';

type Handler = (request: IncomingMessage, body: string, response: ServerResponse) => void;

async function startServer(handler: Handler): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => handler(request, body, response));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}/v1` };
}

function chunk(content: string | null, finishReason: string | null = null): string {
  const delta = content === null ? {} : { content };
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function provider(baseUrl: string, overrides: Partial<OpenAiConfig> = {}) {
  return new OpenAiLlmProvider(
    {
      apiKey: 'sk-test',
      model: 'test-model',
      baseUrl,
      temperature: undefined,
      reasoningEffort: undefined,
      maxOutputTokens: 300,
      timeoutMs: 5_000,
      ...overrides,
    },
    { maxRetries: 0 },
  );
}

function sseServer(capture: (body: Record<string, unknown>) => void): Handler {
  return (_request, body, response) => {
    capture(JSON.parse(body) as Record<string, unknown>);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(chunk('- Answer'));
    response.write(chunk(null, 'stop'));
    response.end('data: [DONE]\n\n');
  };
}

async function collect(iterable: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('OpenAiLlmProvider', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('streams deltas from Chat Completions and reports the finish reason', async () => {
    let captured:
      { headers: IncomingMessage['headers']; body: Record<string, unknown> } | undefined;
    const started = await startServer((request, body, response) => {
      captured = { headers: request.headers, body: JSON.parse(body) as Record<string, unknown> };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(chunk(''));
      response.write(chunk('- Hello'));
      response.write(chunk(' world'));
      response.write(chunk(null, 'length'));
      response.end('data: [DONE]\n\n');
    });
    server = started.server;

    const events = await collect(
      provider(started.baseUrl).stream({
        messages: [{ role: 'user', content: 'Hi' }],
        maxOutputTokens: 123,
        signal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: 'delta', text: '- Hello' },
      { type: 'delta', text: ' world' },
      { type: 'done', finishReason: 'length' },
    ]);
    expect(captured?.headers.authorization).toBe('Bearer sk-test');
    expect(captured?.body).toMatchObject({
      model: 'test-model',
      stream: true,
      max_completion_tokens: 123,
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(captured?.body).not.toHaveProperty('temperature');
    expect(captured?.body).not.toHaveProperty('reasoning_effort');
  });

  it('sends reasoning_effort only when configured (reasoning models such as gpt-oss on Groq)', async () => {
    let body: Record<string, unknown> | undefined;
    const started = await startServer(sseServer((received) => (body = received)));
    server = started.server;

    const events = await collect(
      provider(started.baseUrl, { model: 'openai/gpt-oss-20b', reasoningEffort: 'low' }).stream({
        messages: [{ role: 'user', content: 'Hi' }],
        maxOutputTokens: 1024,
        signal: new AbortController().signal,
      }),
    );

    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(body).toMatchObject({
      model: 'openai/gpt-oss-20b',
      reasoning_effort: 'low',
      max_completion_tokens: 1024,
    });
  });

  it('labels the provider by endpoint so Groq is never shown as OpenAI', () => {
    expect(describeLlmEndpoint(undefined).name).toBe('openai');
    expect(describeLlmEndpoint('https://api.openai.com/v1').name).toBe('openai');
    expect(describeLlmEndpoint('https://api.groq.com/openai/v1')).toEqual({
      name: 'groq',
      label: 'Groq',
    });
    expect(describeLlmEndpoint('http://localhost:11434/v1').name).toBe('openai-compatible');
    expect(describeLlmEndpoint('not a url').name).toBe('openai-compatible');

    const groq = provider('https://api.groq.com/openai/v1', { model: 'openai/gpt-oss-20b' });
    expect(groq.descriptor).toEqual({
      name: 'groq',
      model: 'openai/gpt-oss-20b',
      simulated: false,
    });
  });

  it('names the actual endpoint in rate-limit errors', async () => {
    const started = await startServer((_request, _body, response) => {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Rate limit reached', type: 'tokens' } }));
    });
    server = started.server;
    const failure = collect(
      provider(started.baseUrl).stream({
        messages: [{ role: 'user', content: 'Hi' }],
        maxOutputTokens: 10,
        signal: new AbortController().signal,
      }),
    );
    await expect(failure).rejects.toMatchObject({
      provider: 'openai-compatible',
      message: 'The OpenAI-compatible endpoint rate limit or quota exceeded',
    });
  });

  it('maps authentication failures to a ProviderError with a helpful message', async () => {
    const started = await startServer((_request, _body, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'Incorrect API key', type: 'invalid_request_error' } }),
      );
    });
    server = started.server;
    const stream = provider(started.baseUrl).stream({
      messages: [{ role: 'user', content: 'Hi' }],
      maxOutputTokens: 10,
      signal: new AbortController().signal,
    });
    const failure = collect(stream);
    await expect(failure).rejects.toBeInstanceOf(ProviderError);
    await expect(failure).rejects.toThrow(/rejected the API key/);
  });

  it('stops streaming and throws AbortError when cancelled', async () => {
    const started = await startServer((_request, _body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(chunk('- First'));
      const timer = setInterval(() => response.write(chunk(' more')), 20);
      response.on('close', () => clearInterval(timer));
    });
    server = started.server;
    const controller = new AbortController();
    const received: string[] = [];
    const consume = (async () => {
      for await (const event of provider(started.baseUrl).stream({
        messages: [{ role: 'user', content: 'Hi' }],
        maxOutputTokens: 10,
        signal: controller.signal,
      })) {
        if (event.type === 'delta') received.push(event.text);
        if (received.length === 3) controller.abort();
      }
    })();
    await expect(consume).rejects.toMatchObject({ name: 'AbortError' });
    expect(received.length).toBeGreaterThanOrEqual(3);
  });
});
