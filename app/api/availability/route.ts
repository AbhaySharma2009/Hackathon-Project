import { NextResponse, type NextRequest } from "next/server";
import { ApiError, toErrorResponse } from "@/server/api/errors";
import { parseQuery } from "@/server/api/parse";
import { requireRole } from "@/server/api/session";
import {
  MAX_RANGE_DAYS,
  availabilityQuerySchema,
  buildAvailabilityResponse,
  dayCount,
  resolveRange,
} from "@/server/insights";
import type { AvailabilityDay } from "@/shared/types";

/**
 * GET /api/availability?from=&to=&department=&team=
 *
 * The day-by-day coverage grid behind Team Availability.
 *
 * Scope is chosen here, not in the database, because it depends on who is
 * asking: a manager is pinned to their own reporting line and cannot widen it
 * with a parameter, only HR may name another manager or a department. The RPC
 * then computes the grid, so the numbers are the database's.
 */
export async function GET(request: NextRequest) {
  try {
    const { supabase, employee } = await requireRole("manager", "hr", "admin", "super_admin");
    const query = parseQuery(availabilityQuerySchema, request.nextUrl.searchParams);
    const { from, to } = resolveRange(query);

    // A long window is a query the database should refuse to expand, so it is
    // refused before the call rather than after it.
    const span = dayCount(from, to);
    if (span > MAX_RANGE_DAYS) {
      throw new ApiError("VALIDATION", `Pick a range of at most ${MAX_RANGE_DAYS} days.`, {
        from,
        to,
        days: span,
        max_days: MAX_RANGE_DAYS,
      });
    }

    const isHr = employee.app_role === "hr";

    // ---- resolve the scope --------------------------------------------------
    // A manager is pinned to their own reporting line and cannot widen it with a
    // parameter. HR defaults to the whole organisation and may narrow to a
    // manager or a department.
    let team = query.team ?? null;
    if (team && team !== employee.id && !isHr) {
      throw new ApiError("FORBIDDEN", "You can only view your own team.");
    }
    if (!team && !isHr) {
      team = employee.id;
    }

    const department = team ? null : (query.department ?? null);
    if (team && query.department) {
      throw new ApiError(
        "VALIDATION",
        "Choose either a team or a department, not both — the team filter is narrower.",
        { field: "department" },
      );
    }

    const { data, error } = await supabase.rpc("get_availability", {
      p_from: from,
      p_to: to,
      p_department: department,
      p_manager_id: team,
    });

    if (error) throw error;

    const days = (data ?? []) as AvailabilityDay[];

    return NextResponse.json({
      data: buildAvailabilityResponse({
        days,
        scope: {
          app_role: employee.app_role,
          // HR on the org-wide view has no manager pin, so nothing narrows it.
          org_wide: isHr && !team,
          viewer_id: employee.id,
          basis: team ? "team" : department ? "department" : "organisation",
        },
        from,
        to,
      }),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
