import type { FastifyReply, FastifyRequest } from 'fastify';

/** Transport-agnostic controller result; routes translate it into an HTTP reply. */
export interface HandlerResult<TBody> {
  status: number;
  body?: TBody;
}

/**
 * Adapts a controller method returning `{ status, body }` into a Fastify handler.
 * Thrown errors propagate to the centralised error middleware.
 */
export function asyncHandler<TBody>(
  handler: (request: FastifyRequest) => Promise<HandlerResult<TBody>> | HandlerResult<TBody>,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const result = await handler(request);
    if (result.body === undefined) {
      await reply.code(result.status).send();
      return;
    }
    await reply.code(result.status).send(result.body);
  };
}

/**
 * Runs a promise-returning task without awaiting it while guaranteeing that a
 * rejection is always handled — no floating promises, no unhandled rejections.
 */
export function runDetached(task: () => Promise<unknown>, onError: (error: unknown) => void): void {
  let promise: Promise<unknown>;
  try {
    promise = task();
  } catch (error) {
    safeInvoke(onError, error);
    return;
  }
  promise.catch((error: unknown) => safeInvoke(onError, error));
}

function safeInvoke(onError: (error: unknown) => void, error: unknown): void {
  try {
    onError(error);
  } catch (secondary) {
    console.error('Error handler threw while handling a detached task failure', secondary);
  }
}
