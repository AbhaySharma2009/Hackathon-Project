import "server-only";

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { STATUS_BY_CODE, type ErrorCode } from "@/shared/errors";
import type { Database, LeaveDecision } from "@/shared/types";

type DecisionRpc = "approve_leave_request" | "reject_leave_request";

/**
 * Calls one of the decision RPCs and maps its verdict onto the standard OrgFlow
 * error body. The RPC is authoritative for *whether* the decision was allowed,
 * so this function only translates: a `ok:false` result becomes the error code
 * the RPC chose (OVERLAP, INSUFFICIENT_BALANCE, FORBIDDEN, …) with the HTTP
 * status that code maps to.
 */
export async function decideLeave(
  supabase: SupabaseClient<Database>,
  fn: DecisionRpc,
  requestId: string,
  comment: string | null,
): Promise<NextResponse> {
  const { data, error } = await supabase.rpc(fn, {
    p_request_id: requestId,
    p_comment: comment,
  });

  if (error) throw error;

  const result = data as LeaveDecision;

  if (!result?.ok) {
    const code = (result?.error_code ?? "VALIDATION") as ErrorCode;
    return NextResponse.json(
      {
        error: {
          code,
          message: result?.error_message ?? "The request could not be decided.",
          details: result?.details ?? {},
        },
      },
      { status: STATUS_BY_CODE[code] ?? 422 },
    );
  }

  return NextResponse.json({ data: result.request });
}
