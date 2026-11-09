import type { ApiErrorResponse } from '@shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { AppError, RateLimitError, toAppError } from '../utils/errors';

function isFastifyError(error: unknown): error is FastifyError {
  return error instanceof Error && typeof (error as Partial<FastifyError>).statusCode === 'number';
}

/** Maps any thrown value (ours, Fastify's or unknown) into a consistent AppError. */
export function normalizeHttpError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (isFastifyError(error) && !(error instanceof AppError)) {
    const status = error.statusCode ?? 500;
    if (status === 429) return new RateLimitError(error.message);
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return new AppError('MESSAGE_TOO_LARGE', 'Request body is too large', { statusCode: 413 });
    }
    if (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || error instanceof SyntaxError) {
      return new AppError('MALFORMED_MESSAGE', 'Request body is not valid JSON', {
        statusCode: 400,
      });
    }
    if (status >= 400 && status < 500) {
      return new AppError('VALIDATION_ERROR', error.message, { statusCode: status });
    }
  }
  return toAppError(error);
}

/** Centralised HTTP error handling: one error shape, no stack traces, masked 5xx messages. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const appError = normalizeHttpError(error);
    if (appError.statusCode >= 500) {
      request.log.error({ err: error }, 'Request failed');
    } else {
      request.log.info(
        { code: appError.code, statusCode: appError.statusCode },
        'Request rejected',
      );
    }
    const body: ApiErrorResponse = {
      error: {
        code: appError.code,
        message: appError.publicMessage,
        ...(appError.details === undefined ? {} : { details: appError.details }),
        requestId: request.id,
      },
    };
    void reply.code(appError.statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ApiErrorResponse = {
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
        requestId: request.id,
      },
    };
    void reply.code(404).send(body);
  });
}
