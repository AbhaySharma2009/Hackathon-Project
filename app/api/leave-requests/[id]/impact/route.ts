import { NextResponse, type NextRequest } from "next/server";
import { ApiError, toErrorResponse } from "@/server/api/errors";
import { requireRole } from "@/server/api/session";
import type { LeaveImpact } from "@/shared/types";

type Context = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/leave-requests/[id]/impact
 *
 * What approving this request would do to the team's coverage, shown in the
 * approve dialog before the decision is made.
 *
 * The figures come from `get_leave_impact`, which assumes the request IS granted
 * — otherwise it would report the situation before the change. Authorisation is
 * enforced there too (SQLSTATE 42501), so this route's gate is a convenience and
 * the database remains the enforcement layer.
 */
export async function GET(_request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    if (!UUID_RE.test(id)) throw new ApiError("VALIDATION", "Invalid request id.");

    // The impact of a decision is for the people who make it. An employee is
    // refused here and again inside the RPC.
    const { supabase } = await requireRole("manager", "hr");

    const { data, error } = await supabase.rpc("get_leave_impact", { p_request_id: id });

    if (error) {
      // The RPC raises these two itself, so its codes are the contract.
      if (error.code === "42501") {
        throw new ApiError("FORBIDDEN", "You cannot view the impact of this request.");
      }
      if (error.code === "P0002") {
        throw new ApiError("NOT_FOUND", "That leave request no longer exists.");
      }
      throw error;
    }

    return NextResponse.json({ data: data as LeaveImpact });
  } catch (error) {
    return toErrorResponse(error);
  }
}
