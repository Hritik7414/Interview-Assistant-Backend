import {
  ApiErrorResponseSchema,
  CapabilitiesSchema,
  InterviewResponseSchema,
  MetricsResponseSchema,
} from '@shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInterview, readJson, startTestApp, type TestApp } from '../helpers/test-app';

describe('REST API', () => {
  let ctx: TestApp;
  const api = (path: string, init?: RequestInit) => fetch(`${ctx.baseUrl}${path}`, init);
  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    ctx = await startTestApp({ env: { RATE_LIMIT_MAX_PER_MINUTE: '40' } });
  });
  afterAll(() => ctx.close());

  it('serves liveness and readiness probes', async () => {
    const live = await api('/health');
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ status: 'ok', activeSessions: 0 });
    const ready = await api('/health/ready');
    expect(await ready.json()).toMatchObject({
      status: 'ready',
      modes: { demo: { available: true }, live: { available: false } },
    });
  });

  it('describes capabilities, flagging simulated providers', async () => {
    const body = CapabilitiesSchema.parse(await (await api('/api/v1/capabilities')).json());
    expect(body.modes.demo.transcription.simulated).toBe(true);
    expect(body.modes.live.available).toBe(false);
    expect(body.audio.sampleRate).toBe(16_000);
  });

  it('creates an interview without echoing personal context back', async () => {
    const response = await api(
      '/api/v1/interviews',
      json({ mode: 'demo', context: { resume: 'Secret Corp, 2019-2024' } }),
    );
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain('Secret Corp');
    const { interview } = InterviewResponseSchema.parse(JSON.parse(text));
    expect(interview).toMatchObject({ mode: 'demo', status: 'idle', context: { resumeChars: 22 } });
  });

  it('returns structured validation errors', async () => {
    const response = await api('/api/v1/interviews', json({ mode: 'turbo' }));
    expect(response.status).toBe(400);
    const body = ApiErrorResponseSchema.parse(await readJson(response));
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toEqual({
      issues: [expect.objectContaining({ path: 'body.mode' })],
    });
  });

  it('rejects malformed JSON bodies', async () => {
    const response = await api('/api/v1/interviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"mode":',
    });
    expect(response.status).toBe(400);
    expect((await readJson(response)).error.code).toBe('MALFORMED_MESSAGE');
  });

  it('refuses Live Mode when it is not configured', async () => {
    const response = await api('/api/v1/interviews', json({ mode: 'live' }));
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe('LIVE_MODE_UNAVAILABLE');
  });

  it('supports get, context update, sub-resources and delete', async () => {
    const { id } = await createInterview(ctx.baseUrl);
    const patched = await api(
      `/api/v1/interviews/${id}/context`,
      json({ jobDescription: 'Platform engineer' }, 'PATCH'),
    );
    expect(patched.status).toBe(200);
    expect((await readJson(patched)).interview.context.jobDescriptionChars).toBe(17);

    for (const [path, key] of [
      ['transcript', 'segments'],
      ['questions', 'questions'],
      ['answers', 'answers'],
    ] as const) {
      const response = await api(`/api/v1/interviews/${id}/${path}`);
      expect(response.status).toBe(200);
      expect((await readJson(response))[key]).toEqual([]);
    }
    MetricsResponseSchema.parse(await (await api(`/api/v1/interviews/${id}/metrics`)).json());

    expect((await api(`/api/v1/interviews/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(`/api/v1/interviews/${id}`)).status).toBe(404);
  });

  it('distinguishes unknown ids, invalid ids and unknown routes', async () => {
    const unknown = await api('/api/v1/interviews/7f1c8e0a-6c1e-4b8a-9d55-2f3a0d9b1c11');
    expect(unknown.status).toBe(404);
    expect((await readJson(unknown)).error.code).toBe('INTERVIEW_NOT_FOUND');
    expect((await api('/api/v1/interviews/not-a-uuid')).status).toBe(400);
    expect((await readJson(await api('/api/v1/nothing'))).error.code).toBe('NOT_FOUND');
  });

  it('applies CORS only to allowed origins', async () => {
    const preflight = (origin: string) =>
      api('/api/v1/interviews', {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
    expect(
      (await preflight('http://localhost:3000')).headers.get('access-control-allow-origin'),
    ).toBe('http://localhost:3000');
    expect(
      (await preflight('https://evil.example')).headers.get('access-control-allow-origin'),
    ).toBeNull();
  });

  it('rate-limits interview creation', async () => {
    const limited = await startTestApp({ env: { RATE_LIMIT_MAX_PER_MINUTE: '8' } }); // create limit = 2/min
    try {
      const create = () => fetch(`${limited.baseUrl}/api/v1/interviews`, json({}));
      expect((await create()).status).toBe(201);
      expect((await create()).status).toBe(201);
      const blocked = await create();
      expect(blocked.status).toBe(429);
      expect((await readJson(blocked)).error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });
});
