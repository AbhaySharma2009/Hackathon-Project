import { type NextRequest } from "next/server";
import { toErrorResponse, ApiError } from "@/server/api/errors";
import { parseJson, readJson } from "@/server/api/parse";
import { requireAdmin } from "@/server/api/session";
import { createAdminClient } from "@/server/supabase/admin-core";
import { setActiveSchema } from "@/server/admin";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/users/:id/active — deactivate or restore a login.
 *
 * Deactivating signs the person out of the app without deleting anything: their
 * leave history, balances and past decisions stay exactly as they were. The RPC
 * refuses to deactivate the last active administrator.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new ApiError("VALIDATION", "Invalid employee id.");

    const { employee } = await requireAdmin();
    const { is_active } = parseJson(setActiveSchema, await readJson(request));

    const admin = createAdminClient();
    const { data, error } = await admin.rpc("admin_set_employee_active", {
      p_actor: employee.id,
      p_employee_id: id,
      p_is_active: is_active,
    });

    if (error) throw error;
    return Response.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
