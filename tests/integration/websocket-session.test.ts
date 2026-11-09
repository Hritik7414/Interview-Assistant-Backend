import { MetricsResponseSchema, TranscriptResponseSchema, type LatencyMetricName } from '@shared';
import { afterEach, describe, expect, it } from 'vitest';
import { MockLlmProvider } from '../../src/providers/llm/mock-llm.provider';
import { ProviderRegistry } from '../../src/providers/provider.registry';
import { MockTranscriptionProvider } from '../../src/providers/transcription/mock-transcription.provider';
import {
  AUDIO_FORMAT,
  createInterview,
  startTestApp,
  TEST_SCRIPT,
  type TestApp,
} from '../helpers/test-app';
import { TestWsClient } from '../helpers/ws-test-client';

describe('WebSocket realtime protocol', () => {
  let ctx: TestApp | undefined;
  const clients: TestWsClient[] = [];

  async function setup(options: Parameters<typeof startTestApp>[0] = {}) {
    ctx = await startTestApp(options);
    const interview = await createInterview(ctx.baseUrl);
    const client = await connect();
    return { ctx, interview, client };
  }

  async function connect(origin?: string): Promise<TestWsClient> {
    const client = await TestWsClient.connect(ctx!.wsUrl, origin);
    clients.push(client);
    return client;
  }

  async function startSession(client: TestWsClient, interviewId: string, resumeSessionId?: string) {
    client.send({
      type: 'session.start',
      payload: {
        interviewId,
        audio: AUDIO_FORMAT,
        ...(resumeSessionId ? { resumeSessionId } : {}),
      },
    });
    return client.waitFor('session.ready', (event) => event.payload.interviewId === interviewId);
  }

  afterEach(async () => {
    clients.splice(0).forEach((client) => client.terminate());
    await ctx?.close();
    ctx = undefined;
  });

  it('runs the full lifecycle: ready → listening → stop → stopped', async () => {
    const { client, interview, ctx: app } = await setup();
    const ready = await startSession(client, interview.id);
    expect(ready.payload).toMatchObject({
      resumed: false,
      mode: 'demo',
      providers: { transcription: { simulated: true }, llm: { simulated: true } },
      audio: { sampleRate: 16_000, frameDurationMs: 50 },
    });
    const sessionId = ready.sessionId!;
    await client.waitFor('session.status', (event) => event.payload.state === 'listening');
    expect(app.container.services.sessions.activeCount).toBe(1);

    client.send({ type: 'session.stop', payload: { sessionId } });
    const stopped = await client.waitFor(
      'session.status',
      (event) => event.payload.state === 'stopped',
    );
    expect(stopped.payload.reason).toBe('client_requested');
    expect(app.container.services.sessions.activeCount).toBe(0);
    expect(app.container.services.interviews.get(interview.id).status).toBe('idle');
    expect(client.invalidEvents).toEqual([]);
  });

  it('streams audio → transcripts → question → token-streamed answer', async () => {
    const { client, interview, ctx: app } = await setup();
    await startSession(client, interview.id);

    client.streamAudio(2_500);
    const question = await client.waitFor('question.detected');
    expect(question.payload.question.text).toBe(
      'How would you design a rate limiter for a public API?',
    );
    expect(client.ofType('transcript.partial').length).toBeGreaterThan(0);
    expect(client.ofType('transcript.final').map((e) => e.payload.segment.text)).toContain(
      'Thanks for joining today.',
    );

    const started = await client.waitFor('answer.started');
    expect(started.payload.questionId).toBe(question.payload.question.id);
    const completed = await client.waitFor('answer.completed');
    const deltas = client
      .ofType('answer.delta')
      .filter((e) => e.payload.answerId === started.payload.answerId);
    expect(deltas.length).toBeGreaterThan(10);
    expect(
      deltas
        .map((e) => e.payload.delta)
        .join('')
        .trim(),
    ).toBe(completed.payload.answer.text);
    expect(completed.payload.answer).toMatchObject({
      status: 'completed',
      finishReason: 'stop',
      provider: { simulated: true },
    });
    expect(completed.payload.latency.firstTokenMs).toBeGreaterThan(0);

    // State machine: thinking → answering → listening
    const states = client.ofType('session.status').map((e) => e.payload.state);
    expect(states).toEqual(expect.arrayContaining(['thinking', 'answering']));
    await client.waitFor(
      'session.status',
      (e) => e.payload.state === 'listening' && e.ts >= completed.ts,
    );

    // The statement before the question was not treated as a question.
    expect(client.ofType('question.detected')).toHaveLength(1);

    // Second question (no question mark) is detected after the pause.
    client.streamAudio(5_000);
    const second = await client.waitFor(
      'question.detected',
      (e) => e.payload.question.id !== question.payload.question.id,
    );
    expect(second.payload.question.text).toBe(
      'Tell me about a time you improved system reliability.',
    );

    // REST views reflect the realtime state; metrics are populated.
    const transcript = TranscriptResponseSchema.parse(
      await (await fetch(`${app.baseUrl}/api/v1/interviews/${interview.id}/transcript`)).json(),
    );
    expect(transcript.segments.length).toBeGreaterThanOrEqual(3);
    const { metrics } = MetricsResponseSchema.parse(
      await (await fetch(`${app.baseUrl}/api/v1/interviews/${interview.id}/metrics`)).json(),
    );
    for (const key of [
      'audioIngestion',
      'transcription',
      'questionDetection',
      'llmFirstToken',
      'answerTotal',
      'endToEnd',
    ] as LatencyMetricName[]) {
      expect(metrics[key], key).not.toBeNull();
    }
    expect(client.invalidEvents).toEqual([]);
  });

  it('cancels an in-flight answer on answer.cancel', async () => {
    const providers = new ProviderRegistry({
      demo: {
        transcription: new MockTranscriptionProvider({ script: TEST_SCRIPT, wordDurationMs: 100 }),
        llm: new MockLlmProvider({ firstTokenDelayMs: 10, tokenDelayMs: 100 }),
      },
      live: null,
    });
    const { client, interview } = await setup({ providers });
    const ready = await startSession(client, interview.id);
    client.streamAudio(2_500);
    const started = await client.waitFor('answer.started');
    await client.waitFor('answer.delta');
    client.send({
      type: 'answer.cancel',
      payload: { sessionId: ready.sessionId, answerId: started.payload.answerId },
    });
    const completed = await client.waitFor('answer.completed');
    expect(completed.payload.answer).toMatchObject({
      status: 'cancelled',
      finishReason: 'cancelled',
    });
    await client.waitFor(
      'session.status',
      (e) => e.payload.state === 'listening' && e.ts >= completed.ts,
    );
  });

  it('answers pings with a pong carrying server time', async () => {
    const { client } = await setup();
    client.send({ type: 'session.ping', payload: { clientSentAt: 1234 } });
    const pong = await client.waitFor('session.status', (e) => e.payload.pong !== undefined);
    expect(pong.payload).toMatchObject({ state: 'idle', pong: { clientSentAt: 1234 } });
    expect(pong.payload.pong!.serverReceivedAt).toBeGreaterThan(0);
  });

  it('reports malformed and out-of-order messages without dropping the connection', async () => {
    const { client, interview } = await setup();
    client.sendAudio(50);
    expect((await client.waitFor('session.error')).payload.code).toBe('SESSION_NOT_STARTED');
    client.sendRaw('{not json');
    await client.waitFor('session.error', (e) => e.payload.code === 'MALFORMED_MESSAGE');
    client.send({ type: 'session.stop', payload: { sessionId: 'nope' } });
    await client.waitFor('session.error', (e) => e.payload.code === 'VALIDATION_ERROR');
    client.sendRaw(Buffer.from([9, 9, 9]));
    await client.waitFor('session.error', (e) => e.payload.code === 'INVALID_AUDIO_FRAME');

    // Still usable afterwards.
    const ready = await startSession(client, interview.id);
    expect(ready.sessionId).toBeTruthy();
  });

  it('rejects unknown interviews and duplicate sessions', async () => {
    const { client, interview } = await setup();
    client.send({
      type: 'session.start',
      payload: { interviewId: '7f1c8e0a-6c1e-4b8a-9d55-2f3a0d9b1c11', audio: AUDIO_FORMAT },
    });
    expect((await client.waitFor('session.error')).payload.code).toBe('INTERVIEW_NOT_FOUND');

    await startSession(client, interview.id);
    client.send({
      type: 'session.start',
      payload: { interviewId: interview.id, audio: AUDIO_FORMAT },
    });
    await client.waitFor('session.error', (e) => e.payload.code === 'SESSION_ALREADY_ACTIVE');

    const other = await connect();
    other.send({
      type: 'session.start',
      payload: { interviewId: interview.id, audio: AUDIO_FORMAT },
    });
    expect((await other.waitFor('session.error')).payload.code).toBe('SESSION_ALREADY_ACTIVE');
  });

  it('resumes a session after an unexpected disconnect', async () => {
    const { client, interview, ctx: app } = await setup();
    const ready = await startSession(client, interview.id);
    client.streamAudio(1_000);
    await client.waitFor('transcript.final');
    client.terminate(); // abrupt: no close frame
    await client.closed;

    const reconnected = await connect();
    const resumed = await startSession(reconnected, interview.id, ready.sessionId!);
    expect(resumed.sessionId).toBe(ready.sessionId);
    expect(resumed.payload.resumed).toBe(true);
    reconnected.streamAudio(1_500);
    const question = await reconnected.waitFor('question.detected');
    expect(question.sessionId).toBe(ready.sessionId);
    expect(app.container.services.sessions.activeCount).toBe(1);
  });

  it('stops a suspended session when the resume grace period expires', async () => {
    const {
      client,
      interview,
      ctx: app,
    } = await setup({ env: { SESSION_RESUME_GRACE_MS: '150' } });
    const ready = await startSession(client, interview.id);
    client.terminate();
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(app.container.services.sessions.activeCount).toBe(0);

    const late = await connect();
    late.send({
      type: 'session.start',
      payload: { interviewId: interview.id, resumeSessionId: ready.sessionId, audio: AUDIO_FORMAT },
    });
    expect((await late.waitFor('session.error')).payload.code).toBe('SESSION_NOT_FOUND');
  });

  it('stops the session immediately on a clean close', async () => {
    const { client, interview, ctx: app } = await setup();
    await startSession(client, interview.id);
    await client.close(1000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(app.container.services.sessions.activeCount).toBe(0);
  });

  it('enforces origin checks, message size limits and message rate limits', async () => {
    const { client } = await setup();
    await expect(TestWsClient.connect(ctx!.wsUrl, 'https://evil.example')).rejects.toThrow(/403/);

    for (let i = 0; i < 200; i += 1)
      client.send({ type: 'session.ping', payload: { clientSentAt: i } });
    await client.waitFor('session.error', (e) => e.payload.code === 'RATE_LIMITED');

    // The server closes with 1009; a client still mid-send may only observe the abrupt TCP close (1006).
    const big = await connect();
    big.sendRaw('x'.repeat(300 * 1024));
    expect([1006, 1009]).toContain((await big.closed).code);
  });

  it('limits concurrent connections per IP', async () => {
    await setup({ env: { WS_MAX_CONNECTIONS_PER_IP: '2' } });
    await connect();
    await expect(connect()).rejects.toThrow(/429/);
  });
});
