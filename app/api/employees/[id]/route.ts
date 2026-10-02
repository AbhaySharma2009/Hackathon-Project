import { NextResponse, type NextRequest } from "next/server";
import { ApiError, toErrorResponse } from "@/server/api/errors";
import { requireHrOrAdmin, requireSession } from "@/server/api/session";
import { DIRECTORY_COLUMNS, assertNoManagerCycle, employeeUpdateSchema, parseBody } from "@/server/employees";

type Context = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A missing or malformed body is a validation problem, not a 500. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError("VALIDATION", "A JSON body is required.");
  }
}

/**
 * GET /api/employees/[id]
 *
 * The database decides how much detail is returned (`get_employee_detail`): a
 * full record for self / HR / the person's manager, directory fields otherwise.
 * `auth_user_id` is never returned to anyone.
 */
export async function GET(_request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    if (!UUID_RE.test(id)) throw new ApiError("VALIDATION", "Invalid employee id.");

    const session = await requireSession();

    const { data: detail, error } = await session.supabase.rpc("get_employee_detail", {
      p_employee_id: id,
    });

    if (error) throw new ApiError("NOT_FOUND", error.message);
    if (!detail) throw new ApiError("NOT_FOUND", "Employee not found.");

    const employee = detail as Record<string, unknown>;
    const isSelf = session.employee.id === id;
    const isHr = session.employee.app_role === "hr";
    const isManager = employee.manager_id === session.employee.id;

    // Direct reports, using only directory columns.
    const { data: reports } = await session.supabase
      .from("employees")
      .select("id, name, photo, role, department")
      .eq("manager_id", id)
      .order("name");

    let manager = null;
    if (typeof employee.manager_id === "string") {
      const { data } = await session.supabase
        .from("employees")
        .select("id, name, photo, role, department")
        .eq("id", employee.manager_id)
        .maybeSingle();
      manager = data ?? null;
    }

    return NextResponse.json({
      data: {
        employee,
        manager,
        reports: reports ?? [],
        permissions: {
          is_self: isSelf,
          is_hr: isHr,
          is_manager: isManager,
          // What the caller actually received, so the UI can explain the limit.
          has_full_access: isSelf || isHr || isManager,
          can_manage: isHr || isManager,
          can_edit: isHr,
        },
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * PATCH /api/employees/[id] — HR / Admin / Super Admin editing a profile.
 *
 * The write goes through `admin_update_employee_profile`, never a direct table
 * update. That function is the only place allowed to touch organisation fields,
 * and it is where the authority checks live: HR cannot edit anyone at or above
 * their own tier, and nobody can change their own role, department or manager.
 *
 * This used to call `session.supabase.from("employees").update(patch)`, which
 * depended on the `employees_update_hr` policy — an unrestricted UPDATE for any
 * HR session, on any row, including their own. Phase 16 revoked that policy.
 */
export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    if (!UUID_RE.test(id)) throw new ApiError("VALIDATION", "Invalid employee id.");

    const session = await requireHrOrAdmin();
    const { supabase, employee: actor } = session;
    const body = parseBody(employeeUpdateSchema, await readJson(request));

    const { data: existing } = await supabase
      .from("employees")
      .select(DIRECTORY_COLUMNS)
      .eq("id", id)
      .maybeSingle();

    if (!existing) throw new ApiError("NOT_FOUND", "Employee not found.");

    if ("manager_id" in body) {
      await assertNoManagerCycle(session, id, body.manager_id);
    }

    // Only pass the fields the caller actually sent, so an absent key leaves the
    // stored value alone rather than clearing it.
    const { error } = await supabase.rpc("admin_update_employee_profile", {
      p_actor: actor.id,
      p_employee_id: id,
      p_name: body.name ?? null,
      p_email: body.email ?? null,
      p_photo: body.photo === "" ? null : (body.photo ?? null),
      p_department: body.department ?? null,
      p_manager_id: body.manager_id ?? null,
      p_job_title: body.role ?? null,
      p_join_date: body.join_date ?? null,
    });

    if (error) {
      if (error.code === "23505") {
        throw new ApiError("VALIDATION", "That email address is already in use.", {
          field: "email",
        });
      }
      // The RPC speaks in "FORBIDDEN: ..." / "VALIDATION: ..." prefixes; surface
      // them as the right status rather than flattening everything to 400.
      const [kind, ...rest] = error.message.split(": ");
      if (kind === "FORBIDDEN") throw new ApiError("FORBIDDEN", rest.join(": "));
      if (kind === "NOT_FOUND") throw new ApiError("NOT_FOUND", rest.join(": "));
      throw new ApiError("VALIDATION", error.message);
    }

    const { data: detail } = await supabase.rpc("get_employee_detail", {
      p_employee_id: id,
    });

    return NextResponse.json({ data: detail });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * DELETE /api/employees/[id] — HR only. Soft delete (is_active = false).
 *
 * Deactivating someone who still has active direct reports would orphan them and
 * break the org chart, so the caller must name a replacement manager via
 * `?reassign_to=<employee-id>`.
 */
export async function DELETE(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    if (!UUID_RE.test(id)) throw new ApiError("VALIDATION", "Invalid employee id.");

    const session = await requireHrOrAdmin();

    if (id === session.employee.id) {
      throw new ApiError("VALIDATION", "You cannot deactivate your own account.");
    }

    const { data: existing } = await session.supabase
      .from("employees")
      .select(DIRECTORY_COLUMNS)
      .eq("id", id)
      .maybeSingle();

    if (!existing) throw new ApiError("NOT_FOUND", "Employee not found.");

    const { data: reports } = await session.supabase
      .from("employees")
      .select("id, name, is_active")
      .eq("manager_id", id)
      .eq("is_active", true);

    const activeReports = reports ?? [];
    const reassignTo = request.nextUrl.searchParams.get("reassign_to");

    if (activeReports.length > 0) {
      if (!reassignTo) {
        throw new ApiError(
          "VALIDATION",
          `${activeReports.length} direct report(s) still report to ${existing.name}. Choose who takes over before deactivating.`,
          { direct_reports: activeReports, field: "reassign_to" },
        );
      }
      if (reassignTo === id) {
        throw new ApiError("VALIDATION", "A deactivated employee cannot take over a team.");
      }
      await Promise.all(
        // Each report moves under `reassignTo`; check the move would not put a
        // manager underneath one of their own reports.
        activeReports.map((report) => assertNoManagerCycle(session, report.id, reassignTo)),
      );

      const { error: reassignError } = await session.supabase
        .from("employees")
        .update({ manager_id: reassignTo })
        .eq("manager_id", id);
      if (reassignError) throw new ApiError("VALIDATION", reassignError.message);
    }

    const { error } = await session.supabase
      .from("employees")
      .update({ is_active: false })
      .eq("id", id);
    if (error) throw new ApiError("VALIDATION", error.message);

    return NextResponse.json({ data: { id, is_active: false, reassigned_reports: activeReports.length } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
