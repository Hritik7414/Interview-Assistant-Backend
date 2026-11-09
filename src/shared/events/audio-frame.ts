import {
  AUDIO_FRAME_HEADER_BYTES,
  AUDIO_FRAME_MAX_PAYLOAD_BYTES,
  AUDIO_FRAME_TYPE,
  AUDIO_FRAME_VERSION,
} from '../constants/audio.constants';
import { CLIENT_EVENT } from './event-names';
import type { AudioChunkEvent } from './client-events.schema';

/**
 * Binary `audio.chunk` envelope (little-endian):
 *
 *   offset  size  field
 *   0       1     frame type (0x01 = audio)
 *   1       1     version (1)
 *   2       2     reserved (0)
 *   4       4     uint32 sequence number
 *   8       8     float64 capture timestamp (epoch ms, server clock)
 *   16      n     PCM16LE mono samples (n must be even)
 */
export interface AudioFrameInput {
  seq: number;
  capturedAt: number;
  pcm: Int16Array | Uint8Array;
}

export type AudioFrameDecodeResult =
  { ok: true; frame: AudioChunkEvent } | { ok: false; reason: string };

export function encodeAudioFrame({ seq, capturedAt, pcm }: AudioFrameInput): ArrayBuffer {
  const payload = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const buffer = new ArrayBuffer(AUDIO_FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(buffer);
  view.setUint8(0, AUDIO_FRAME_TYPE);
  view.setUint8(1, AUDIO_FRAME_VERSION);
  view.setUint16(2, 0, true);
  view.setUint32(4, seq >>> 0, true);
  view.setFloat64(8, capturedAt, true);
  new Uint8Array(buffer, AUDIO_FRAME_HEADER_BYTES).set(payload);
  return buffer;
}

export function decodeAudioFrame(data: ArrayBuffer | Uint8Array): AudioFrameDecodeResult {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < AUDIO_FRAME_HEADER_BYTES) {
    return { ok: false, reason: 'Frame shorter than header' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== AUDIO_FRAME_TYPE) {
    return { ok: false, reason: 'Unknown frame type' };
  }
  if (view.getUint8(1) !== AUDIO_FRAME_VERSION) {
    return { ok: false, reason: 'Unsupported frame version' };
  }
  const payloadBytes = bytes.byteLength - AUDIO_FRAME_HEADER_BYTES;
  if (payloadBytes === 0 || payloadBytes % 2 !== 0) {
    return { ok: false, reason: 'PCM16 payload must be a non-empty even number of bytes' };
  }
  if (payloadBytes > AUDIO_FRAME_MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: 'Audio payload exceeds maximum frame size' };
  }
  const capturedAt = view.getFloat64(8, true);
  if (!Number.isFinite(capturedAt) || capturedAt < 0) {
    return { ok: false, reason: 'Invalid capture timestamp' };
  }
  return {
    ok: true,
    frame: {
      type: CLIENT_EVENT.AUDIO_CHUNK,
      seq: view.getUint32(4, true),
      capturedAt,
      pcm: bytes.subarray(AUDIO_FRAME_HEADER_BYTES),
    },
  };
}
