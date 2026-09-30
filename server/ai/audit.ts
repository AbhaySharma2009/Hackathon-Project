import "server-only";

/**
 * Audit trail for copilot tool calls.
 *
 * Rule 5 is easy to state and easy to erode, so every tool invocation leaves a
 * row: who asked, which tool, the arguments after validation, whether it worked,
 * and how long it took. That is what makes the whitelist checkable after the
 * fact rather than merely claimed.
 *
 * The write uses the service-role client on purpose. A browser session has no
 * INSERT policy on `ai_audit_log`, so a compromised or tampered client cannot
 * forge an entry to cover for a call it made, or plant one that looks like
 * somebody else's. The employee id recorded is always the one resolved from the
 * session — never an argument the model supplied.
 */
import { createAdminClient } from "@/server/supabase/admin";

export type AuditEntry = {
  employeeId: string;
  toolName: string;
  /** Already zod-validated, so it cannot carry anything the tool did not declare. */
  arguments: Record<string, unknown>;
  success: boolean;
  error?: string | null;
  durationMs?: number;
};

/**
 * Flattens anything throwable into a line worth keeping.
 *
 * A rejected Supabase call is a plain object, not an `Error`, and `String()` on
 * one yields "[object Object]" — which records that something failed without
 * saying what. Its `message` is read explicitly so the audit row is a usable
 * trail rather than a row of noise.
 */
function summarise(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message.slice(0, 500);
    try {
      return JSON.stringify(error).slice(0, 500);
    } catch {
      return "unserialisable error object";
    }
  }
  return String(error).slice(0, 500);
}

/** Exported so the query dispatcher records failures the same way. */
export { summarise as summariseError };

/**
 * Records one tool call. Never throws: an audit failure must not turn a working
 * answer into an error for the user, so it is logged and swallowed.
 */
export async function auditToolCall(entry: AuditEntry): Promise<void> {
  try {
    const { error } = await createAdminClient().from("ai_audit_log").insert({
      employee_id: entry.employeeId,
      tool_name: entry.toolName,
      arguments: entry.arguments,
      success: entry.success,
      error: entry.error ?? null,
      duration_ms: entry.durationMs ?? null,
    });
    if (error) console.error("[ai] audit write failed", error.message);
  } catch (error) {
    console.error("[ai] audit write threw", error);
  }
}

/** Wraps a tool handler so every call is timed and recorded, then audited. */
export async function withAudit<T>(
  entry: Omit<AuditEntry, "success" | "error" | "durationMs">,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();

  try {
    const result = await run();
    await auditToolCall({
      ...entry,
      success: true,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    await auditToolCall({
      ...entry,
      success: false,
      error: summarise(error),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
