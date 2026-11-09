import type { ErrorCode } from '@shared';
import { DomainError } from '../mvc/models/domain-error';

interface AppErrorOptions {
  statusCode?: number;
  details?: unknown;
  cause?: unknown;
  /** Whether the client may retry / continue the session after this error. */
  recoverable?: boolean;
  /** Whether `message` is safe to show to clients. Internal errors are masked. */
  expose?: boolean;
}

/** Base class for every error the application raises deliberately. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly recoverable: boolean;
  readonly expose: boolean;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.statusCode = options.statusCode ?? 500;
    this.details = options.details;
    this.recoverable = options.recoverable ?? true;
    this.expose = options.expose ?? this.statusCode < 500;
  }

  /** Message that is safe to send over the wire. */
  get publicMessage(): string {
    return this.expose ? this.message : 'An unexpected error occurred';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown, code: ErrorCode = 'VALIDATION_ERROR') {
    super(code, message, { statusCode: 400, details });
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, code: ErrorCode = 'NOT_FOUND') {
    super(code, message, { statusCode: 404 });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: ErrorCode = 'CONFLICT') {
    super(code, message, { statusCode: 409 });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super('RATE_LIMITED', message, { statusCode: 429 });
  }
}

export class ProviderError extends AppError {
  readonly provider: string;

  constructor(
    code: Extract<ErrorCode, 'TRANSCRIPTION_PROVIDER_ERROR' | 'LLM_PROVIDER_ERROR'>,
    provider: string,
    message: string,
    options: { cause?: unknown; recoverable?: boolean; statusCode?: number } = {},
  ) {
    // Provider messages are curated by the adapters, so they are safe to expose.
    super(code, message, {
      statusCode: options.statusCode ?? 502,
      cause: options.cause,
      recoverable: options.recoverable ?? true,
      expose: true,
    });
    this.provider = provider;
  }
}

const DOMAIN_ERROR_STATUS: Partial<Record<ErrorCode, number>> = {
  VALIDATION_ERROR: 400,
  SESSION_ALREADY_ACTIVE: 409,
  CONFLICT: 409,
};

/** Normalises anything thrown into an AppError (unknown errors become masked 500s). */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof DomainError) {
    return new AppError(error.code, error.message, {
      statusCode: DOMAIN_ERROR_STATUS[error.code] ?? 422,
      cause: error,
    });
  }
  return new AppError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error), {
    statusCode: 500,
    cause: error,
    expose: false,
  });
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError')
  );
}
