import { type NextRequest } from "next/server";
import { toErrorResponse, ApiError } from "@/lib/api/errors";
import { parseJson, readJson } from "@/lib/api/parse";
import { requireRole } from "@/lib/api/session";
import { rejectSchema } from "@/lib/leave";
import { decideLeave } from "@/lib/leave-decision";

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

    const { supabase } = await requireRole("manager", "hr");
    const { comment } = parseJson(rejectSchema, await readJson(request));

    return decideLeave(supabase, "reject_leave_request", id, comment);
  } catch (error) {
    return toErrorResponse(error);
  }
}
