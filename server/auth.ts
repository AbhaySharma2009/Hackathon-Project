import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import type { AppRole, Employee } from "@/shared/types";

export type CurrentEmployee = Employee & { app_role: AppRole };

/**
 * An error that means "this request carried no usable session" rather than a real
 * failure. PostgREST raises these when the access token is missing, malformed,
 * expired or badly signed, and they are exactly the cases `auth.getUser()` used to
 * catch before the query was ever attempted.
 */
function isAuthFailure(error: { code?: string; message?: string }): boolean {
  if (error.code === "PGRST301" || error.code === "PGRST302") return true;
  return /JWT|token|signature/i.test(error.message ?? "");
}

/**
 * Resolves the signed-in employee row from the auth session.
 *
 * `cache()` dedupes this per request, so the shell, the page and any nested
 * server component share one round trip. The employee is always looked up from
 * `auth.uid()` — never from a parameter, a cookie or model output.
 *
 * The row comes from the `current_employee()` RPC rather than a table select:
 * column-level grants mean a session cannot `select *` from `employees`, but a
 * person is always allowed to read their own record in full.
 *
 * One round trip, not two. This used to call `auth.getUser()` first and then the
 * RPC, which cost a second trip to the Auth server on every request that the proxy
 * had already validated. The RPC resolves `auth.uid()` from the same access token,
 * and PostgREST validates that token before it reaches Postgres, so the token check
 * is not skipped by dropping the extra call — it is simply done in the hop we were
 * making anyway. What that call bought was a clean "not signed in" result, which is
 * why both of its outcomes are preserved explicitly below: a rejected token is an
 * absent employee, and a session with no employee row returns every column as null.
 */
export const getCurrentEmployee = cache(async (): Promise<CurrentEmployee | null> => {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("current_employee").maybeSingle();

  if (error) {
    if (isAuthFailure(error)) return null;
    throw new Error(`Failed to load employee: ${error.message}`);
  }

  // Anonymous callers are not rejected by PostgREST — the anon role is simply not
  // mapped to a user — so the function answers with one row of nulls. A person
  // without an `id` is nobody.
  const employee = data as CurrentEmployee | null;
  if (!employee?.id) return null;

  return employee;
});

/** Server-side role gate. UI visibility is a convenience; this is the guard. */
export async function requireRole(...roles: AppRole[]): Promise<CurrentEmployee> {
  const employee = await getCurrentEmployee();
  if (!employee) throw new Error("UNAUTHENTICATED");
  if (!roles.includes(employee.app_role)) throw new Error("FORBIDDEN");
  return employee;
}

/**
 * Same check as `requireRole`, but redirects instead of throwing — for pages
 * that should bounce an unauthorised user to their own dashboard. Mirrors the
 * RLS policies; it does not replace them.
 */
export async function redirectUnlessRole(...roles: AppRole[]): Promise<CurrentEmployee> {
  const employee = await getCurrentEmployee();
  if (!employee) redirect("/login");
  if (!roles.includes(employee.app_role)) redirect("/dashboard");
  return employee;
}
