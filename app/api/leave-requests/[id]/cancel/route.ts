import { type NextRequest } from "next/server";
import { toErrorResponse, ApiError } from "@/server/api/errors";
import { requireSession } from "@/server/api/session";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/leave-requests/:id/cancel
 *
 * Withdraws a request the caller submitted. Any signed-in role may call this for
 * their *own* request — an administrator cancelling their own leave is ordinary
 * self-service, not an administrative act — so the gate here is a session rather
 * than a role.
 *
 * Eligibility (still pending, not yet started, and yours) is enforced by
 * `cancel_leave_request` itself. This handler deliberately does not duplicate
 * those checks: a second implementation of the same rule is a second rule to keep
 * in step, and the database is already the authority.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new ApiError("VALIDATION", "Invalid request id.");

    const { supabase } = await requireSession();

    const { data, error } = await supabase.rpc("cancel_leave_request", {
      p_request_id: id,
    });
    if (error) throw error;

    return Response.json({ data }, { status: 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}