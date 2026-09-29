/**
 * Standard OrgFlow error shape (Global Context rule 7). Every route handler and
 * server action returns `{ error: { code, message, details? } }` on failure so
 * the client never has to guess the failure mode.
 *
 * This module is deliberately isomorphic — it is imported by client components
 * through the shared validation helpers, so it must not pull in `next/server`.
 * Response construction lives in `lib/api/errors.ts`.
 */
export type ErrorCode =
  | "OVERLAP"
  | "INSUFFICIENT_BALANCE"
  | "INVALID_DATES"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION";

/**
 * Thrown by server code to produce a standard error body. Kept free of
 * server-only imports so shared modules can raise it without dragging
 * `next/server` into a client bundle.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiErrorBody = {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
};

export function errorBody(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorBody {
  return { error: details ? { code, message, details } : { code, message } };
}

/** HTTP status that matches each business error code. */
export const STATUS_BY_CODE: Record<ErrorCode, number> = {
  OVERLAP: 409,
  INSUFFICIENT_BALANCE: 409,
  INVALID_DATES: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
};
