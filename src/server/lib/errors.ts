/**
 * Domain errors. The HTTP layer and the MCP layer translate these into
 * protocol-appropriate responses. Messages must never include record content
 * belonging to a record the caller cannot access.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Also used when a record exists but is not accessible, to avoid leaking existence. */
export class NotFoundError extends AppError {
  constructor(what = 'Record') {
    super(`${what} not found`, 404, 'not_found');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that') {
    super(message, 403, 'forbidden');
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Please sign in') {
    super(message, 401, 'unauthenticated');
  }
}

export class ValidationError extends AppError {
  constructor(message: string, fields?: Record<string, string>) {
    super(message, 400, 'validation_error', fields ? { fields } : undefined);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'conflict');
  }
}

export class RateLimitedError extends AppError {
  constructor(public readonly retryAfterSeconds: number) {
    super('Too many attempts. Please wait and try again.', 429, 'rate_limited', {
      retryAfterSeconds,
    });
  }
}

/** Raised when an OAuth/MCP token lacks a scope required for an operation. */
export class InsufficientScopeError extends AppError {
  constructor(public readonly requiredScopes: string[]) {
    super(`This connection has not been granted: ${requiredScopes.join(', ')}`, 403, 'insufficient_scope', {
      requiredScopes,
    });
  }
}

/** PostgreSQL error code from a driver error, including when wrapped by Drizzle. */
export function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}
