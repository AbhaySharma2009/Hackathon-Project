import { toErrorResponse } from "@/server/api/errors";
import { requireSuperAdmin } from "@/server/api/session";
import { createAdminClient } from "@/server/supabase/admin-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/super-admin/access — who may be assigned which role.
 *
 * Super-Admin-only. This is deliberately *not* served from `/api/admin/users`,
 * because the answer differs by viewer: an Admin may assign everything except
 * `super_admin`, and the server has to say so rather than letting the UI infer
 * it. `admin_role_assignable` in the database is the authority — this route only
 * relays what it says, so a crafted POST cannot widen the list.
 */
export async function GET() {
  try {
    const { employee } = await requireSuperAdmin();
    const admin = createAdminClient();

    const { data, error } = await admin.rpc("admin_role_catalog", { p_actor: employee.id });
    if (error) throw error;

    return Response.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}