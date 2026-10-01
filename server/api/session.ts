import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentEmployee, type CurrentEmployee } from "@/server/auth";
import { createClient } from "@/server/supabase/server";
import { ApiError } from "@/server/api/errors";
import type { AppRole, Database } from "@/shared/types";

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

/**
 * Requires the administrator tier, mirroring `public.is_admin` in the database.
 *
 * HR is deliberately *not* included. `requireRole` treats the tiers as an exact
 * list, so the admin routes name `admin` explicitly rather than relying on a
 * numeric comparison that could drift.
 */
export async function requireAdmin(): Promise<Session> {
  return requireRole("admin");
}

/** The administrator tier plus HR, which shares org-wide visibility. */
export const requireHr = () => requireRole("hr");

/** Admin or HR. Used by the org-wide read endpoints both tiers may call. */
export const requireHrOrAdmin = () => requireRole("hr", "admin");