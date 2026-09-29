import { NextResponse, type NextRequest } from "next/server";
import { ApiError, toErrorResponse } from "@/server/api/errors";
import { parseQuery } from "@/server/api/parse";
import { requireRole } from "@/server/api/session";
import { leaveListSchema } from "@/server/leave";
import { DIRECTORY_COLUMNS } from "@/server/employees";
import type { ApprovalRequest, LeaveRequest } from "@/shared/types";

/**
 * GET /api/approvals?status=
 *
 * The manager inbox: every leave request the caller may *decide* — their direct
 * reports' for a manager, the whole org for HR — with the directory fields
 * needed to render a row so the table needs no second request.
 *
 * Scope is resolved from the session, never from the query string, and RLS
 * filters the rows underneath, so the two layers agree by construction.
 */
export async function GET(request: NextRequest) {
  try {
    const { supabase, employee } = await requireRole("manager", "hr");
    const { status } = parseQuery(leaveListSchema, request.nextUrl.searchParams);

    // ---- who is in scope ----------------------------------------------------
    const isHr = employee.app_role === "hr";

    const { data: scope, error: scopeError } = isHr
      ? await supabase.from("employees").select(DIRECTORY_COLUMNS).eq("is_active", true)
      : await supabase
          .from("employees")
          .select(DIRECTORY_COLUMNS)
          .eq("manager_id", employee.id)
          .eq("is_active", true);

    if (scopeError) throw scopeError;
    if (!scope) throw new ApiError("NOT_FOUND", "Could not resolve the team scope.");

    // The caller is excluded either way: you never decide your own leave, and
    // the RPC would reject it regardless.
    const people = new Map(
      scope.filter((person) => person.id !== employee.id).map((person) => [person.id, person]),
    );

    if (people.size === 0) {
      return NextResponse.json({ data: [], meta: { counts: countByStatus([]) } });
    }

    // ---- their requests -----------------------------------------------------
    // Fetched unfiltered so the tab counts describe the whole inbox, then narrowed
    // in memory. The set is one team's requests, so this stays cheap.
    const { data: rows, error } = await supabase
      .from("leave_requests")
      .select(
        "id, employee_id, leave_type, start_date, end_date, days, reason, status, manager_comment, decided_by, decided_at, created_at",
      )
      .in("employee_id", [...people.keys()])
      .order("start_date", { ascending: false });

    if (error) throw error;

    const all: ApprovalRequest[] = (rows ?? []).flatMap((row: LeaveRequest) => {
      const person = people.get(row.employee_id);
      if (!person) return [];
      return [
        {
          ...row,
          employee_name: person.name,
          employee_photo: person.photo,
          employee_role: person.role,
          employee_department: person.department,
        },
      ];
    });

    return NextResponse.json({
      data: status ? all.filter((row) => row.status === status) : all,
      meta: { counts: countByStatus(all), viewer: { id: employee.id, app_role: employee.app_role } },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

function countByStatus(rows: ApprovalRequest[]) {
  const counts: Record<"pending" | "approved" | "rejected", number> = {
    pending: 0,
    approved: 0,
    rejected: 0,
  };
  for (const row of rows) {
    if (row.status === "pending") counts.pending += 1;
    else if (row.status === "approved") counts.approved += 1;
    else if (row.status === "rejected") counts.rejected += 1;
  }
  return counts;
}
