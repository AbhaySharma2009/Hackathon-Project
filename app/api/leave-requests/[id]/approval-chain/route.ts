import { NextResponse, type NextRequest } from "next/server";
import { ApiError, toErrorResponse } from "@/server/api/errors";
import { requireSession } from "@/server/api/session";
import type { ApprovalChain } from "@/shared/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/leave-requests/:id/approval-chain
 *
 * The frozen chain for one request: every level, who holds it, and what happened
 * to it. Readable by the requester, anybody named on the chain, and HR.
 *
 * The chain is resolved by `get_approval_chain`, a SECURITY DEFINER function that
 * checks the viewer itself. Nothing about the approvers is derived here — a client
 * cannot ask this route "who should sign X" and get an answer it was not entitled
 * to, and the route never accepts an employee_id, an approver or a level from the
 * request body or query.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new ApiError("VALIDATION", "Invalid request id.");

    const { supabase } = await requireSession();

    const { data, error } = await supabase.rpc("get_approval_chain", {
      p_request_id: id,
    });

    if (error) throw error;

    const result = data as
      | { ok: true; chain: ApprovalChain }
      | { ok: false; error_code: string; error_message: string };

    if (!result?.ok) {
      const code = (result?.error_code ?? "NOT_FOUND") as "NOT_FOUND" | "FORBIDDEN";
      throw new ApiError(code, result?.error_message ?? "That chain could not be read.");
    }

    return NextResponse.json({ data: result.chain });
  } catch (error) {
    return toErrorResponse(error);
  }
}
