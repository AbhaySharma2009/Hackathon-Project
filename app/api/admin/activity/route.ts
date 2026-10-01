import { toErrorResponse } from "@/server/api/errors";
import { parseQuery } from "@/server/api/parse";
import { requireAdmin } from "@/server/api/session";
import { createAdminClient } from "@/server/supabase/admin-core";
import { z } from "zod";
import type { AdminActivityLog } from "@/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * GET /api/admin/activity — live workflow totals and the AI audit tail.
 *
 * The AI audit table is not readable by ordinary employees, so this uses the
 * service role. Authority was established by `requireAdmin()` first, and the id
 * of the verified session is passed as `p_actor` so the RPC re-checks that this
 * caller really is an administrator.
 */
export async function GET(request: Request) {
  try {
    const { employee } = await requireAdmin();
    const { limit } = parseQuery(querySchema, new URL(request.url).searchParams);

    const admin = createAdminClient();
    const { data, error } = await admin.rpc("admin_activity_log", {
      p_actor: employee.id,
      p_limit: limit,
    });
    if (error) throw error;

    return Response.json({ data: data as AdminActivityLog });
  } catch (error) {
    return toErrorResponse(error);
  }
}
