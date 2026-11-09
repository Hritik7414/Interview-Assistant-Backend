import { encodeAudioFrame } from '@shared';
import { describe, expect, it } from 'vitest';
import { normalizeHttpError } from '../../../src/middleware/error.middleware';
import { TokenBucket } from '../../../src/middleware/rate-limit.middleware';
import { parseOrThrow } from '../../../src/middleware/validation.middleware';
import { DomainError } from '../../../src/mvc/models/domain-error';
import { AppError, ValidationError } from '../../../src/utils/errors';
import {
  CreateInterviewBodySchema,
  UpdateContextBodySchema,
} from '../../../src/validators/interview.validator';
import { parseClientMessage } from '../../../src/validators/websocket.validator';

const INTERVIEW_ID = '7f1c8e0a-6c1e-4b8a-9d55-2f3a0d9b1c11';

describe('websocket validator', () => {
  it('parses valid JSON client events', () => {
    const data = Buffer.from(
      JSON.stringify({ type: 'session.ping', payload: { clientSentAt: 5 } }),
    );
    expect(parseClientMessage(data, false)).toEqual({
      kind: 'event',
      event: { type: 'session.ping', payload: { clientSentAt: 5 } },
    });
  });

  it('rejects malformed JSON and schema violations', () => {
    expect(parseClientMessage(Buffer.from('{oops'), false)).toMatchObject({
      kind: 'invalid',
      code: 'MALFORMED_MESSAGE',
    });
    expect(
      parseClientMessage(
        Buffer.from(JSON.stringify({ type: 'session.start', payload: { interviewId: 'x' } })),
        false,
      ),
    ).toMatchObject({ kind: 'invalid', code: 'VALIDATION_ERROR' });
  });

  it('decodes binary audio frames, including fragmented buffers', () => {
    const frame = Buffer.from(encodeAudioFrame({ seq: 3, capturedAt: 10, pcm: new Int16Array(8) }));
    const fragmented = [frame.subarray(0, 10), frame.subarray(10)];
    const parsed = parseClientMessage(fragmented, true);
    expect(parsed).toMatchObject({ kind: 'audio', frame: { seq: 3, capturedAt: 10 } });
  });

  it('rejects invalid binary frames', () => {
    expect(parseClientMessage(Buffer.from([1, 2, 3]), true)).toMatchObject({
      kind: 'invalid',
      code: 'INVALID_AUDIO_FRAME',
    });
  });

  it('rejects messages above the size limit', () => {
    expect(parseClientMessage(Buffer.alloc(300 * 1024), false)).toMatchObject({
      code: 'MESSAGE_TOO_LARGE',
    });
  });
});

describe('interview validators', () => {
  it('applies defaults to create requests', () => {
    expect(parseOrThrow(CreateInterviewBodySchema, {}, 'body')).toEqual({
      mode: 'demo',
      context: { resume: '', jobDescription: '', instructions: '' },
    });
  });

  it('throws ValidationError with issue paths', () => {
    try {
      parseOrThrow(CreateInterviewBodySchema, { mode: 'nope' }, 'body');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toEqual({
        issues: [expect.objectContaining({ path: 'body.mode' })],
      });
    }
  });

  it('validates context patches', () => {
    expect(UpdateContextBodySchema.safeParse({}).success).toBe(false);
    expect(UpdateContextBodySchema.safeParse({ resume: 'x' }).success).toBe(true);
    expect(
      CreateInterviewBodySchema.safeParse({ context: { interviewId: INTERVIEW_ID } }).success,
    ).toBe(true);
  });
});

describe('TokenBucket', () => {
  it('allows bursts up to capacity then refills over time', () => {
    let now = 0;
    const bucket = new TokenBucket(3, 2, () => now);
    expect([
      bucket.tryRemove(),
      bucket.tryRemove(),
      bucket.tryRemove(),
      bucket.tryRemove(),
    ]).toEqual([true, true, true, false]);
    now = 500; // +1 token
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
    now = 10_000;
    expect([
      bucket.tryRemove(),
      bucket.tryRemove(),
      bucket.tryRemove(),
      bucket.tryRemove(),
    ]).toEqual([true, true, true, false]);
  });
});

describe('normalizeHttpError', () => {
  it('maps domain errors and masks unknown errors', () => {
    expect(normalizeHttpError(new DomainError('SESSION_ALREADY_ACTIVE', 'busy'))).toMatchObject({
      statusCode: 409,
    });
    const internal = normalizeHttpError(new Error('db password is hunter2'));
    expect(internal.statusCode).toBe(500);
    expect(internal.publicMessage).not.toContain('hunter2');
  });

  it('maps Fastify framework errors', () => {
    const tooLarge = Object.assign(new Error('too big'), {
      statusCode: 413,
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    });
    expect(normalizeHttpError(tooLarge)).toMatchObject({
      code: 'MESSAGE_TOO_LARGE',
      statusCode: 413,
    });
    const limited = Object.assign(new Error('slow down'), { statusCode: 429 });
    expect(normalizeHttpError(limited)).toMatchObject({ code: 'RATE_LIMITED' });
    expect(normalizeHttpError(new AppError('CONFLICT', 'x', { statusCode: 409 })).code).toBe(
      'CONFLICT',
    );
  });
});
