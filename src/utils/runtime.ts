import { randomUUID } from 'node:crypto';

/** Injectable time source — lets services be tested with fake timers or fixed clocks. */
export type Clock = () => number;
export const systemClock: Clock = () => Date.now();

/** Injectable id factory. */
export type IdGenerator = () => string;
export const uuidGenerator: IdGenerator = () => randomUUID();

/** Resolves after `ms`, rejecting with an AbortError as soon as `signal` aborts. Never leaks timers. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortErrorFrom(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortErrorFrom(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortErrorFrom(signal?: AbortSignal): Error {
  const error = new Error(
    signal?.reason instanceof Error ? signal.reason.message : 'The operation was aborted',
  );
  error.name = 'AbortError';
  return error;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
