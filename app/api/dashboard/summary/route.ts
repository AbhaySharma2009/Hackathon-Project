import { NextResponse } from "next/server";
import { ApiError, toErrorResponse } from "@/server/api/errors";
import { requireRole } from "@/server/api/session";
import type { DashboardSummary } from "@/shared/types";

/**
 * GET /api/dashboard/summary
 *
 * Every HR dashboard figure in one payload, computed entirely by
 * `get_dashboard_summary()` so the page cannot mix figures from two different
 * moments.
 *
 * Scope is decided in the database from the session, never from a parameter:
 *   hr      -> the whole organisation
 *   manager -> their direct reports plus themselves
 *   employee-> 403, in the route gate and again inside the RPC
 */
export async function GET() {
  try {
    // The UI hides the page from employees, but the request is rejected here even
    // if it is made directly. The RPC repeats the check, so the database is the
    // enforcement layer rather than this route.
    const { supabase } = await requireRole("hr", "manager", "admin", "super_admin");

    const { data, error } = await supabase.rpc("get_dashboard_summary");

    if (error) {
      // The RPC signals an unauthorised caller with SQLSTATE 42501
      // (insufficient_privilege). Surface it as the standard FORBIDDEN body
      // rather than leaking the raw database message.
      if (error.code === "42501") {
        throw new ApiError("FORBIDDEN", "You do not have access to the HR dashboard.");
      }
      throw error;
    }

    return NextResponse.json({ data: data as DashboardSummary });
  } catch (error) {
    return toErrorResponse(error);
  }
}
