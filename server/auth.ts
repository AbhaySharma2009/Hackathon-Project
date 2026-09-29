import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import type { AppRole, Employee } from "@/shared/types";

export type CurrentEmployee = Employee & { app_role: AppRole };

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
 */
export const getCurrentEmployee = cache(async (): Promise<CurrentEmployee | null> => {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) return null;

  const { data, error } = await supabase.rpc("current_employee").maybeSingle();

  if (error) throw new Error(`Failed to load employee: ${error.message}`);

  return (data as CurrentEmployee | null) ?? null;
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
