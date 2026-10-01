import { type NextRequest } from "next/server";
import { toErrorResponse, ApiError } from "@/server/api/errors";
import { parseJson, readJson } from "@/server/api/parse";
import { requireRole } from "@/server/api/session";
import { approveSchema } from "@/server/leave";
import { decideLeave } from "@/server/leave-decision";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/leave-requests/:id/approve — body: { comment?: string }
 *
 * The role gate here is only a fast rejection for a clearer message. The real
 * authorisation happens inside the RPC, which also proves the caller is this
 * employee's *direct* manager rather than a sibling manager — and this is the
 * only action in the app that moves a balance.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new ApiError("VALIDATION", "Invalid request id.");

    const { supabase } = await requireRole("manager", "hr", "admin", "super_admin");
    const { comment } = parseJson(approveSchema, await readJson(request));

    return decideLeave(supabase, "approve_leave_request", id, comment || null);
  } catch (error) {
    return toErrorResponse(error);
  }
}
