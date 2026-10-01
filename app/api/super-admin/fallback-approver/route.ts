import { type NextRequest } from "next/server";
import { toErrorResponse } from "@/server/api/errors";
import { parseJson, readJson } from "@/server/api/parse";
import { requireSuperAdmin } from "@/server/api/session";
import { createAdminClient } from "@/server/supabase/admin-core";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `null` clears the fallback, which is a legitimate state: it means a Super
 * Admin's own leave is parked as blocked rather than self-approved. A UUID must
 * name an active employee who is not the requester.
 */
const setFallbackSchema = z.object({
  employee_id: z.string().refine((v) => UUID_RE.test(v), "Invalid employee id.").nullable(),
});

/**
 * GET/PUT /api/super-admin/fallback-approver
 *
 * Who signs a Super Admin's own leave. Super-Admin-only, because this is the
 * control that stops the top role approving itself: with no fallback configured
 * the request cannot be routed at all, and the database will not invent an
 * approver.
 */
export async function GET() {
  try {
    const { employee } = await requireSuperAdmin();
    const admin = createAdminClient();

    const { data, error } = await admin.rpc("admin_role_catalog", { p_actor: employee.id });
    if (error) throw error;

    return Response.json({ data: { fallback_approver_id: (data as { fallback_approver_id?: string | null })?.fallback_approver_id ?? null } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { employee } = await requireSuperAdmin();
    const { employee_id } = parseJson(setFallbackSchema, await readJson(request));

    if (employee_id) {
      const admin = createAdminClient();
      const { data: target, error } = await admin
        .from("employees")
        .select("id, is_active")
        .eq("id", employee_id)
        .maybeSingle();

      if (error) throw error;
      if (!target) throw new Error("NOT_FOUND: no employee with that id");
      if (!(target as { is_active: boolean }).is_active) {
        throw new Error("VALIDATION: the fallback approver must be an active employee");
      }
      if (employee_id === employee.id) {
        // Belt and braces. The database already excludes the requester when
        // resolving the fallback, but refusing it at the point of configuration
        // means the bad value can never be stored in the first place.
        throw new Error("VALIDATION: the fallback approver cannot be yourself");
      }
    }

    const admin = createAdminClient();
    const { data, error } = await admin
      .from("approval_policy")
      .update({ super_admin_fallback_employee_id: employee_id, updated_at: new Date().toISOString() })
      .eq("id", true)
      .select("super_admin_fallback_employee_id")
      .single();

    if (error) throw error;

    return Response.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}