import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentEmployee, type CurrentEmployee } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ApiError } from "@/lib/api/errors";
import type { AppRole, Database } from "@/lib/types";

export type Session = {
  /** Cookie-bound client, so every query below is still filtered by RLS. */
  supabase: SupabaseClient<Database>;
  employee: CurrentEmployee;
};

/** Requires a valid session; the employee always comes from the auth cookie. */
export async function requireSession(): Promise<Session> {
  const employee = await getCurrentEmployee();
  if (!employee) throw new ApiError("FORBIDDEN", "You must be signed in.");

  return { supabase: await createClient(), employee };
}

/**
 * Server-side role gate. The UI hides these actions, but the request is rejected
 * here even if the call is made directly — and RLS rejects it underneath.
 */
export async function requireRole(...roles: AppRole[]): Promise<Session> {
  const session = await requireSession();
  if (!roles.includes(session.employee.app_role)) {
    throw new ApiError("FORBIDDEN", "Your role does not have access to this action.");
  }
  return session;
}

export const requireHr = () => requireRole("hr");
