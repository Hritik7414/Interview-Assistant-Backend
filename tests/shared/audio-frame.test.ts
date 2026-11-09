import { describe, expect, it } from 'vitest';
import {
  AUDIO_FRAME_HEADER_BYTES,
  AUDIO_FRAME_MAX_PAYLOAD_BYTES,
  decodeAudioFrame,
  encodeAudioFrame,
} from '../../src/shared';

describe('audio frame codec', () => {
  it('round-trips sequence, timestamp and PCM payload', () => {
    const pcm = new Int16Array([0, 1200, -1200, 32767, -32768]);
    const encoded = encodeAudioFrame({ seq: 42, capturedAt: 1_700_000_000_123.5, pcm });

    expect(encoded.byteLength).toBe(AUDIO_FRAME_HEADER_BYTES + pcm.byteLength);

    const decoded = decodeAudioFrame(encoded);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame.type).toBe('audio.chunk');
    expect(decoded.frame.seq).toBe(42);
    expect(decoded.frame.capturedAt).toBe(1_700_000_000_123.5);
    const samples = new Int16Array(
      decoded.frame.pcm.buffer.slice(
        decoded.frame.pcm.byteOffset,
        decoded.frame.pcm.byteOffset + decoded.frame.pcm.byteLength,
      ),
    );
    expect(Array.from(samples)).toEqual(Array.from(pcm));
  });

  it('decodes frames delivered as a Node Buffer view with a non-zero offset', () => {
    const encoded = new Uint8Array(
      encodeAudioFrame({ seq: 7, capturedAt: 10, pcm: new Int16Array(4) }),
    );
    const padded = new Uint8Array(encoded.byteLength + 8);
    padded.set(encoded, 8);
    const decoded = decodeAudioFrame(padded.subarray(8));
    expect(decoded.ok && decoded.frame.seq).toBe(7);
  });

  it.each([
    ['too short', new Uint8Array(4)],
    [
      'wrong type',
      (() => {
        const f = new Uint8Array(
          encodeAudioFrame({ seq: 1, capturedAt: 1, pcm: new Int16Array(2) }),
        );
        f[0] = 0x09;
        return f;
      })(),
    ],
    [
      'wrong version',
      (() => {
        const f = new Uint8Array(
          encodeAudioFrame({ seq: 1, capturedAt: 1, pcm: new Int16Array(2) }),
        );
        f[1] = 9;
        return f;
      })(),
    ],
    [
      'empty payload',
      new Uint8Array(encodeAudioFrame({ seq: 1, capturedAt: 1, pcm: new Int16Array(0) })),
    ],
    [
      'odd payload',
      new Uint8Array(encodeAudioFrame({ seq: 1, capturedAt: 1, pcm: new Uint8Array(3) })),
    ],
    [
      'oversized payload',
      new Uint8Array(
        encodeAudioFrame({
          seq: 1,
          capturedAt: 1,
          pcm: new Uint8Array(AUDIO_FRAME_MAX_PAYLOAD_BYTES + 2),
        }),
      ),
    ],
    [
      'negative timestamp',
      new Uint8Array(encodeAudioFrame({ seq: 1, capturedAt: -5, pcm: new Int16Array(2) })),
    ],
  ])('rejects a frame that is %s', (_label, frame) => {
    expect(decodeAudioFrame(frame).ok).toBe(false);
  });
});
