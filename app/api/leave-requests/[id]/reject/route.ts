import { type NextRequest } from "next/server";
import { toErrorResponse, ApiError } from "@/server/api/errors";
import { parseJson, readJson } from "@/server/api/parse";
import { requireRole } from "@/server/api/session";
import { rejectSchema } from "@/server/leave";
import { decideLeave } from "@/server/leave-decision";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/leave-requests/:id/reject — body: { comment: string }
 *
 * A rejection must carry a reason; the zod schema and the RPC both enforce it,
 * so an empty comment cannot reach the database.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new ApiError("VALIDATION", "Invalid request id.");

    const { supabase } = await requireRole("manager", "hr", "admin", "super_admin");
    const { comment } = parseJson(rejectSchema, await readJson(request));

    return decideLeave(supabase, "reject_leave_request", id, comment);
  } catch (error) {
    return toErrorResponse(error);
  }
}
