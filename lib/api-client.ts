"use client";

import type { ErrorCode } from "@/lib/errors";

export class ClientApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: { issues?: { path: string; message: string }[]; [k: string]: unknown },
  ) {
    super(message);
    this.name = "ClientApiError";
  }

  /** Field-level messages, so a form can highlight the offending input. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const issue of this.details?.issues ?? []) out[issue.path] = issue.message;
    return out;
  }
}

/** Thin fetch wrapper that unwraps the standard OrgFlow error body. */
export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = payload?.error;
    throw new ClientApiError(
      error?.code ?? "VALIDATION",
      error?.message ?? "Request failed.",
      error?.details,
    );
  }

  return payload as T;
}
