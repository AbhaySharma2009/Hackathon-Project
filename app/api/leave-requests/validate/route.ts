import { NextResponse, type NextRequest } from "next/server";
import { toErrorResponse } from "@/server/api/errors";
import { parseJson, readJson } from "@/server/api/parse";
import { requireSession } from "@/server/api/session";
import { leaveRequestSchema } from "@/server/leave";

/**
 * POST /api/leave-requests/validate — dry run, inserts nothing.
 *
 * The whole decision is made by the `validate_leave_request` RPC, which acts on
 * the caller resolved from the auth session. The request body carries only the
 * dates and type: there is no way to validate on behalf of someone else.
 */
export async function POST(request: NextRequest) {
  try {
    const { supabase } = await requireSession();
    const body = parseJson(leaveRequestSchema, await readJson(request));

    const { data, error } = await supabase.rpc("validate_leave_request", {
      p_leave_type: body.leave_type,
      p_start: body.start_date,
      p_end: body.end_date,
    });

    if (error) throw error;

    // The result is returned as-is — including a failure — so the form can show
    // the exact message the database produced.
    return NextResponse.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
