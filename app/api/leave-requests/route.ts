import { NextResponse, type NextRequest } from "next/server";
import { parseJson, parseQuery, readJson } from "@/server/api/parse";
import { ApiError, toErrorResponse } from "@/server/api/errors";
import { requireSession } from "@/server/api/session";
import { leaveListSchema, leaveRequestSchema } from "@/server/leave";

/**
 * GET /api/leave-requests?status=&employee_id=
 *
 * Row visibility comes from RLS: an employee sees their own requests, a manager
 * their direct reports', HR everything. The explicit `can_manage` check only
 * exists to return a clear FORBIDDEN instead of a silently empty list.
 */
export async function GET(request: NextRequest) {
  try {
    const { supabase, employee } = await requireSession();
    const query = parseQuery(leaveListSchema, request.nextUrl.searchParams);

    const targetId = query.employee_id ?? employee.id;
    if (targetId !== employee.id) {
      const { data: allowed } = await supabase.rpc("can_manage", {
        p_employee_id: targetId,
      });
      if (!allowed) {
        throw new ApiError("FORBIDDEN", "You can only view leave for yourself or your team.");
      }
    }

    let select = supabase
      .from("leave_requests")
      .select(
        "id, employee_id, leave_type, start_date, end_date, days, reason, status, manager_comment, decided_by, decided_at, created_at",
      )
      .eq("employee_id", targetId)
      .order("start_date", { ascending: false });

    if (query.status) select = select.eq("status", query.status);

    const { data, error } = await select;
    if (error) throw error;

    return NextResponse.json({
      data: data ?? [],
      meta: {
        total: data?.length ?? 0,
        viewer: { id: employee.id, app_role: employee.app_role },
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * POST /api/leave-requests — creates a pending request.
 *
 * `create_leave_request` re-runs every rule inside its own transaction; the
 * result here is whatever the database decided.
 */
export async function POST(request: NextRequest) {
  try {
    const { supabase } = await requireSession();
    const body = parseJson(leaveRequestSchema, await readJson(request));

    const { data, error } = await supabase.rpc("create_leave_request", {
      p_leave_type: body.leave_type,
      p_start: body.start_date,
      p_end: body.end_date,
      p_reason: body.reason,
    });

    if (error) throw error;

    if (!data?.valid) {
      // Map the database verdict onto the standard error shape. A failed
      // validation is a conflict-style error with the overlaps attached.
      return NextResponse.json(
        {
          error: {
            code: data?.error_code ?? "VALIDATION",
            message: data?.error_message ?? "The request could not be created.",
            details: { days: data?.days, conflicts: data?.conflicts ?? [] },
          },
        },
        { status: statusFor(data?.error_code) },
      );
    }

    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

function statusFor(code: string | null | undefined): number {
  switch (code) {
    case "OVERLAP":
    case "INSUFFICIENT_BALANCE":
      return 409;
    case "INVALID_DATES":
      return 400;
    case "FORBIDDEN":
      return 403;
    default:
      return 422;
  }
}
