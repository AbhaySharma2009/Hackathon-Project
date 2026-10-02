import { NextResponse, type NextRequest } from "next/server";
import { ApiError, toErrorResponse } from "@/server/api/errors";
import { parseQuery } from "@/server/api/parse";
import { requireRole } from "@/server/api/session";
import { leaveListSchema } from "@/server/leave";
import { DIRECTORY_COLUMNS } from "@/server/employees";
import type { ApprovalStep, ApprovalRequest, LeaveRequest } from "@/shared/types";

/**
 * GET /api/approvals?status=
 *
 * The approver inbox. Phase 3.5 changed what "an approver" means: a manager now
 * sees a request when they hold the ACTIVE step, which is not the same as being
 * that employee's direct manager. A department head therefore sees long requests
 * from their whole department even though those people report to somebody else,
 * and stops seeing a request the moment it moves past them.
 *
 * HR keeps org-wide visibility (every request) because that is its job, and
 * `viewer_can_decide` on each row is decided by the database, not here: it is
 * `can_decide_leave_step`, the same predicate the decision RPCs enforce, so the
 * buttons on screen and the permission actually checked on submit are the same
 * question asked the same way. HR deciding outside its own step is an override,
 * and the override is offered rather than merely permitted.
 *
 * Scope comes from the session and the rows from RLS; the client never names a
 * team, an employee or a level.
 */
export async function GET(request: NextRequest) {
  try {
    const { supabase, employee } = await requireRole("manager", "hr", "admin", "super_admin");
    const { status } = parseQuery(leaveListSchema, request.nextUrl.searchParams);

    const isHr = employee.app_role === "hr";

    // ---- who is in scope ----------------------------------------------------
    // A manager's scope is their reporting line; HR's is the whole directory.
    // Either way the caller is excluded: you never decide your own leave, and the
    // RPC would refuse it regardless.
    const { data: scope, error: scopeError } = isHr
      ? await supabase.from("employees").select(DIRECTORY_COLUMNS).eq("is_active", true)
      : await supabase
          .from("employees")
          .select(DIRECTORY_COLUMNS)
          .eq("manager_id", employee.id)
          .eq("is_active", true);

    if (scopeError) throw scopeError;
    if (!scope) throw new ApiError("NOT_FOUND", "Could not resolve the team scope.");

    const people = new Map(
      scope.filter((person) => person.id !== employee.id).map((person) => [person.id, person]),
    );

    // A manager can also hold a department-head step for people who do not report
    // to them, so their reachable set is the union of both, not just the direct
    // reports above.
    const { data: deptScope, error: deptError } = await supabase
      .from("employees")
      .select("id, department")
      .eq("department", employee.department)
      .eq("is_active", true)
      .neq("id", employee.id);

    if (deptError) throw deptError;
    for (const person of deptScope ?? []) {
      if (!people.has(person.id)) people.set(person.id, { id: person.id, department: person.department } as never);
    }

    if (people.size === 0) {
      return NextResponse.json({ data: [], meta: { counts: countByStatus([]), viewer: viewerMeta(employee) } });
    }

    // ---- their requests -----------------------------------------------------
    const ids = [...people.keys()];

    const { data: rows, error } = await supabase
      .from("leave_requests")
      .select(
        "id, employee_id, leave_type, start_date, end_date, days, reason, status, manager_comment, decided_by, decided_at, current_approval_level, blocked_reason, created_at",
      )
      .in("employee_id", ids)
      .order("start_date", { ascending: false });

    if (error) throw error;

    // ---- the chains, in one round trip --------------------------------------
    // Fetched for the whole candidate set rather than per request: the inbox is
    // one team's requests, so this stays a single cheap query instead of N.
    const requestIds = (rows ?? []).map((r) => r.id);
    const { data: stepRows, error: stepError } = requestIds.length
      ? await supabase
          .from("leave_approval_steps")
          .select("id, leave_request_id, level, approver_employee_id, approver_role, status, comment, decided_at, created_at")
          .in("leave_request_id", requestIds)
          .order("level")
      : { data: [], error: null };

    if (stepError) throw stepError;

    const { data: approverNames, error: nameError } = await supabase
      .from("employees")
      .select("id, name")
      .in("id", [...new Set((stepRows ?? []).map((s) => s.approver_employee_id))].filter(Boolean));

    if (nameError) throw nameError;
    const nameOf = new Map((approverNames ?? []).map((p) => [p.id, p.name]));

    const chains = new Map<string, ApprovalStep[]>();
    for (const step of stepRows ?? []) {
      const list = chains.get(step.leave_request_id) ?? [];
      list.push({ ...step, approver_name: nameOf.get(step.approver_employee_id) ?? "Unknown", is_current: false });
      chains.set(step.leave_request_id, list);
    }

    const all: ApprovalRequest[] = (rows ?? []).flatMap((row: LeaveRequest) => {
      const person = people.get(row.employee_id);
      if (!person) return [];

      const steps = chains.get(row.id) ?? [];
      // Only the row's own current level counts as "current"; the chain is what
      // the viewer would be signing against.
      const activeLevel = row.current_approval_level;

      return [
        {
          ...row,
          employee_name: person.name,
          employee_photo: person.photo,
          employee_role: person.role,
          employee_department: person.department,
          approval_chain: steps.map((s) => ({ ...s, is_current: s.level === activeLevel })),
          viewer_level: null,
          viewer_can_decide: false,
        },
      ];
    });

    // ---- who may actually decide -------------------------------------------
    // Phase 19. The buttons used to be shown only to the approver literally
    // assigned to the active step. That was narrower than what the database
    // enforces: `approve_leave_request` also lets HR sign any request as an
    // override, and HR is the only role that can clear an `approval_blocked`
    // request, which by definition has no active step and so could never light
    // up a button for anybody. The result was capability with no affordance.
    //
    // The authority is not re-implemented here. `can_decide_leave_step` is the
    // same database predicate the decision RPCs are governed by, so the UI and
    // the enforcement cannot drift apart.
    //
    // The predicate deliberately says nothing about the request's status, so the
    // status gate is applied on top: a decided request is history, and offering
    // "Approve" on one would just produce a VALIDATION error.
    const decidable = all.filter((row) => row.status === "pending" || row.status === "approval_blocked");

    await Promise.all(
      decidable.map(async (row) => {
        const { data, error: decideError } = await supabase.rpc("can_decide_leave_step", {
          p_request_id: row.id,
          // A blocked request has no current level. Passing null asks the
          // predicate "is any of my steps outstanding", which for a blocked
          // request is only ever true through HR's override.
          p_level: row.current_approval_level,
        });
        if (decideError) throw decideError;
        if (data !== true) return;
        row.viewer_can_decide = true;
        row.viewer_level = row.current_approval_level;
      }),
    );

    return NextResponse.json({
      data: status ? all.filter((row) => row.status === status) : all,
      meta: { counts: countByStatus(all), viewer: viewerMeta(employee) },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

function viewerMeta(employee: { id: string; app_role: string }) {
  return { id: employee.id, app_role: employee.app_role };
}

function countByStatus(rows: ApprovalRequest[]) {
  const counts: Record<"pending" | "approved" | "rejected" | "approval_blocked", number> = {
    pending: 0,
    approved: 0,
    rejected: 0,
    approval_blocked: 0,
  };
  for (const row of rows) {
    if (row.status in counts) counts[row.status as keyof typeof counts] += 1;
  }
  return counts;
}
