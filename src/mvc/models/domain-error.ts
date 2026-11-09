import type { ErrorCode } from '@shared';

/** Raised when a business invariant is violated. Transport-agnostic by design. */
export class DomainError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
