import { type NextRequest } from "next/server";
import { toErrorResponse, ApiError } from "@/server/api/errors";
import { parseJson, readJson } from "@/server/api/parse";
import { requireAdmin } from "@/server/api/session";
import { createAdminClient } from "@/server/supabase/admin-core";
import { updateEmployeeSchema } from "@/server/admin";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/admin/users/:id — change role, department, reporting line or title.
 *
 * `admin_update_employee` rejects the two mistakes that would quietly break the
 * org: demoting the last administrator, and appointing a plain employee as a
 * manager. A reporting cycle is caught by the `prevent_manager_cycle` trigger.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new ApiError("VALIDATION", "Invalid employee id.");

    const { employee } = await requireAdmin();
    const input = parseJson(updateEmployeeSchema, await readJson(request));

    // An empty patch would succeed while doing nothing, which reads as success
    // and hides the mistake.
    if (Object.keys(input).length === 0) {
      throw new ApiError("VALIDATION", "Nothing to change.");
    }

    const admin = createAdminClient();
    const { data, error } = await admin.rpc("admin_update_employee", {
      p_actor: employee.id,
      p_employee_id: id,
      p_app_role: input.app_role ?? null,
      p_department: input.department ?? null,
      p_manager_id: input.manager_id ?? null,
      p_job_title: input.job_title ?? null,
    });

    if (error) throw error;
    return Response.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
