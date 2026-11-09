import {
  ClientJsonEventSchema,
  decodeAudioFrame,
  WS_MAX_MESSAGE_BYTES,
  type AudioChunkEvent,
  type ClientJsonEvent,
  type ErrorCode,
} from '@shared';
import { z } from 'zod';

/** Raw payload shapes `ws` can deliver. */
export type RawWsData = Buffer | ArrayBuffer | Buffer[];

export type ParsedClientMessage =
  | { kind: 'event'; event: ClientJsonEvent }
  | { kind: 'audio'; frame: AudioChunkEvent }
  | { kind: 'invalid'; code: ErrorCode; message: string };

export function toUint8Array(data: RawWsData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

/**
 * Validates every inbound frame: binary frames must be well-formed audio
 * envelopes, text frames must be JSON matching the client event schema.
 */
export function parseClientMessage(data: RawWsData, isBinary: boolean): ParsedClientMessage {
  const bytes = toUint8Array(data);
  if (bytes.byteLength > WS_MAX_MESSAGE_BYTES) {
    return { kind: 'invalid', code: 'MESSAGE_TOO_LARGE', message: 'Message exceeds size limit' };
  }

  if (isBinary) {
    const decoded = decodeAudioFrame(bytes);
    return decoded.ok
      ? { kind: 'audio', frame: decoded.frame }
      : { kind: 'invalid', code: 'INVALID_AUDIO_FRAME', message: decoded.reason };
  }

  let json: unknown;
  try {
    json = JSON.parse(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'),
    );
  } catch {
    return { kind: 'invalid', code: 'MALFORMED_MESSAGE', message: 'Message is not valid JSON' };
  }

  const result = ClientJsonEventSchema.safeParse(json);
  if (!result.success) {
    return {
      kind: 'invalid',
      code: 'VALIDATION_ERROR',
      message: `Invalid client event: ${z.prettifyError(result.error).slice(0, 300)}`,
    };
  }
  return { kind: 'event', event: result.data };
}
