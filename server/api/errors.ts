import { NextResponse } from "next/server";
import { ApiError, STATUS_BY_CODE } from "@/shared/errors";

/**
 * Response-side half of the error contract. The `ApiError` class itself lives in
 * the isomorphic `@/shared/errors` so shared validation helpers can throw it from
 * modules that client components also import.
 */
export { ApiError, type ApiErrorBody, type ErrorCode } from "@/shared/errors";

export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      {
        error: error.details
          ? { code: error.code, message: error.message, details: error.details }
          : { code: error.code, message: error.message },
      },
      { status: STATUS_BY_CODE[error.code] },
    );
  }

  // Never leak raw driver or database internals to the client.
  console.error("[api] unhandled error", error);
  return NextResponse.json(
    { error: { code: "VALIDATION", message: "Something went wrong. Please try again." } },
    { status: 500 },
  );
}
