import "server-only";

import { z } from "zod";
import { ApiError } from "@/shared/errors";

/**
 * Request parsing helpers shared by the route handlers. Server-only because they
 * turn untrusted input into `ApiError`s that `toErrorResponse` renders — the
 * isomorphic schemas they validate against live in `lib/leave.ts` and
 * `lib/employees.ts` so client components can share them.
 */
export function parseQuery<T>(schema: z.ZodType<T>, params: URLSearchParams): T {
  const parsed = schema.safeParse(Object.fromEntries(params.entries()));
  if (!parsed.success) {
    throw new ApiError("VALIDATION", "Invalid query parameters.", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return parsed.data;
}

export function parseJson<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid request.", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return parsed.data;
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError("VALIDATION", "A JSON body is required.");
  }
}
