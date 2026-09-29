import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api/errors";
import { parseQuery } from "@/lib/api/parse";
import { requireSession } from "@/lib/api/session";
import type { CalendarLeave } from "@/lib/types";

const calendarQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, "Use YYYY-MM for the month."),
  department: z.string().trim().max(80).optional(),
  team: z.string().uuid("Use a manager's employee id for the team filter.").optional(),
});

/**
 * GET /api/calendar?month=YYYY-MM&department=&team=
 *
 * Approved leave overlapping the month, for the monthly team calendar.
 *
 * All of the interesting work is in `get_calendar_leaves`, which derives the
 * viewer's scope from the session and can only be narrowed by the filters here —
 * never widened. The route exists to validate input and hand back JSON.
 */
export async function GET(request: NextRequest) {
  try {
    const { supabase, employee } = await requireSession();
    const query = parseQuery(calendarQuerySchema, request.nextUrl.searchParams);

    const { data, error } = await supabase.rpc("get_calendar_leaves", {
      p_month_start: `${query.month}-01`,
      p_department: query.department ?? null,
      p_team: query.team ?? null,
    });

    if (error) throw error;

    return NextResponse.json({
      data: (data ?? []) as CalendarLeave[],
      meta: { month: query.month, viewer: { id: employee.id, app_role: employee.app_role } },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
