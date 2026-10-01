import { toErrorResponse, ApiError } from "@/server/api/errors";
import { parseJson, readJson } from "@/server/api/parse";
import { requireAdmin } from "@/server/api/session";
import { createAdminClient } from "@/server/supabase/admin-core";
import { createEmployeeSchema } from "@/server/admin";
import type { AdminUser } from "@/shared/types";

/**
 * GET /api/admin/users — every person in the organisation.
 *
 * This goes through `admin_list_employees` rather than reading the table, because
 * `email` and `app_role` are deliberately not granted to browser sessions. The
 * function re-checks `is_admin()` itself, so this route is not the only thing
 * standing between a caller and the restricted columns.
 */
export async function GET() {
  try {
    const { employee } = await requireAdmin();

    const admin = createAdminClient();
    const { data, error } = await admin.rpc("admin_list_employees", {
      p_actor: employee.id,
    });

    if (error) throw error;
    return Response.json({ data: (data as AdminUser[]) ?? [] });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * POST /api/admin/users — add a person.
 *
 * The Supabase Auth user is created first, then the matching `employees` row, and
 * the pair is rolled back if the second step fails so a login without an org
 * record (or the reverse) is never left behind.
 *
 * The service role is used because creating an auth user is not something a
 * user's own session token may do. Authority was established by `requireAdmin()`
 * above, and the id of the verified session is passed as `p_actor` so
 * `admin_create_employee` re-checks that this caller really is an administrator.
 */
export async function POST(request: Request) {
  let createdAuthId: string | null = null;

  try {
    const { employee } = await requireAdmin();
    const input = parseJson(createEmployeeSchema, await readJson(request));

    const admin = createAdminClient();

    const { data: auth, error: authError } = await admin.auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,
    });

    if (authError || !auth.user) {
      throw new ApiError("VALIDATION", authError?.message ?? "Could not create the login.");
    }
    createdAuthId = auth.user.id;

    const { data, error } = await admin.rpc("admin_create_employee", {
      p_actor: employee.id,
      p_employee_id: createdAuthId,
      p_email: input.email,
      p_full_name: input.full_name,
      p_app_role: input.app_role,
      p_department: input.department,
      p_manager_id: input.manager_id,
      p_job_title: input.job_title,
    } as never);

    if (error) throw error;

    return Response.json({ data }, { status: 201 });
  } catch (error) {
    // The login exists but the org record does not, so remove the orphan. A user
    // who cannot be resolved to an employee has no access to anything.
    if (createdAuthId) {
      const admin = createAdminClient();
      await admin.auth.admin.deleteUser(createdAuthId);
    }
    return toErrorResponse(error);
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
