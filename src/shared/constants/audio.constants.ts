/**
 * Audio wire format shared by the browser capture pipeline and the server.
 * The browser always resamples to this format so every STT provider receives
 * identical input (16 kHz, mono, signed 16-bit little-endian PCM).
 */
export const AUDIO_ENCODING = 'linear16' as const;
export const AUDIO_SAMPLE_RATE = 16_000;
export const AUDIO_CHANNELS = 1;
export const AUDIO_BYTES_PER_SAMPLE = 2;

/** Duration of one captured frame. 50 ms keeps added latency low at 20 msgs/s. */
export const AUDIO_FRAME_DURATION_MS = 50;
export const AUDIO_SAMPLES_PER_FRAME = (AUDIO_SAMPLE_RATE * AUDIO_FRAME_DURATION_MS) / 1000;

/** Binary audio frame envelope (see docs/websocket-protocol.md). */
export const AUDIO_FRAME_TYPE = 0x01;
export const AUDIO_FRAME_VERSION = 1;
export const AUDIO_FRAME_HEADER_BYTES = 16;
/** Upper bound for one frame payload: one second of audio. */
export const AUDIO_FRAME_MAX_PAYLOAD_BYTES = AUDIO_SAMPLE_RATE * AUDIO_BYTES_PER_SAMPLE;

/** Converts a PCM16 byte length into milliseconds of audio. */
export function pcmBytesToMs(byteLength: number, sampleRate: number = AUDIO_SAMPLE_RATE): number {
  return (byteLength / AUDIO_BYTES_PER_SAMPLE / sampleRate) * 1000;
}
