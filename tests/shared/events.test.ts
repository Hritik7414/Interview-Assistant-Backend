import { describe, expect, it } from 'vitest';
import {
  ClientJsonEventSchema,
  CONTEXT_LIMITS,
  CreateInterviewRequestSchema,
  createServerEvent,
  InterviewContextPatchSchema,
  ServerEventSchema,
} from '../../src/shared';

const INTERVIEW_ID = '7f1c8e0a-6c1e-4b8a-9d55-2f3a0d9b1c11';
const SESSION_ID = '0b9d3e4f-1a2b-4c5d-8e9f-a0b1c2d3e4f5';

describe('client events', () => {
  it('accepts a valid session.start', () => {
    const result = ClientJsonEventSchema.safeParse({
      type: 'session.start',
      payload: {
        interviewId: INTERVIEW_ID,
        audio: { encoding: 'linear16', sampleRate: 16000, channels: 1 },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown event types and malformed payloads', () => {
    expect(ClientJsonEventSchema.safeParse({ type: 'session.hack', payload: {} }).success).toBe(
      false,
    );
    expect(
      ClientJsonEventSchema.safeParse({ type: 'session.stop', payload: { sessionId: 'nope' } })
        .success,
    ).toBe(false);
    expect(
      ClientJsonEventSchema.safeParse({
        type: 'session.start',
        payload: {
          interviewId: INTERVIEW_ID,
          audio: { encoding: 'opus', sampleRate: 16000, channels: 1 },
        },
      }).success,
    ).toBe(false);
  });
});

describe('server events', () => {
  it('builds events that satisfy the shared schema', () => {
    const event = createServerEvent('answer.delta', SESSION_ID, {
      answerId: INTERVIEW_ID,
      delta: 'Hello',
      index: 0,
    });
    expect(ServerEventSchema.safeParse(event).success).toBe(true);
    expect(event.type).toBe('answer.delta');
  });

  it('allows a null session id for pre-session errors', () => {
    const event = createServerEvent('session.error', null, {
      code: 'MALFORMED_MESSAGE',
      message: 'bad json',
      recoverable: true,
    });
    expect(ServerEventSchema.safeParse(event).success).toBe(true);
  });
});

describe('context schemas', () => {
  it('applies defaults and trims text', () => {
    const parsed = CreateInterviewRequestSchema.parse({ context: { resume: '  Engineer  ' } });
    expect(parsed.mode).toBe('demo');
    expect(parsed.context).toEqual({ resume: 'Engineer', jobDescription: '', instructions: '' });
  });

  it('enforces size limits', () => {
    const tooLong = 'x'.repeat(CONTEXT_LIMITS.resume + 1);
    expect(CreateInterviewRequestSchema.safeParse({ context: { resume: tooLong } }).success).toBe(
      false,
    );
  });

  it('requires at least one field in a patch', () => {
    expect(InterviewContextPatchSchema.safeParse({}).success).toBe(false);
    expect(InterviewContextPatchSchema.safeParse({ instructions: 'Be brief' }).success).toBe(true);
  });
});
