import { toErrorResponse } from "@/server/api/errors";
import { parseJson, readJson } from "@/server/api/parse";
import { requireAdmin } from "@/server/api/session";
import { approvalPolicySchema } from "@/server/admin";
import type { ApprovalPolicy, RequiredApprovalLevels } from "@/shared/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/approval-policy — the thresholds, and what they currently imply.
 *
 * `required_approval_levels` is evaluated through the caller's own session so the
 * preview comes from the same function `create_leave_request` uses, rather than
 * from a copy of the rule kept in the UI.
 */
export async function GET() {
  try {
    const { supabase } = await requireAdmin();

    const { data: rows, error } = await supabase.from("approval_policy").select("*").limit(1);
    if (error) throw error;

    const policy = (rows ?? [])[0] as ApprovalPolicy | undefined;
    if (!policy) throw new Error("The approval policy row is missing.");

    const samples = await Promise.all(
      [1, 3, 4, 7, 8, 14].map(async (days) => {
        const { data } = await supabase.rpc("required_approval_levels", { p_days: days });
        return { days, levels: data as RequiredApprovalLevels };
      }),
    );

    return Response.json({ data: { policy, samples } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * PATCH /api/admin/approval-policy
 *
 * Changing these thresholds changes who must sign off future requests. Existing
 * chains are immutable snapshots, so requests already in flight keep the routing
 * they were built with — that is deliberate, and worth stating plainly to the
 * administrator rather than leaving it as a surprise.
 */
export async function PATCH(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const input = parseJson(approvalPolicySchema, await readJson(request));

    if (input.short_leave_max_days >= input.medium_leave_max_days) {
      throw new Error("The short-leave limit must be below the medium-leave limit.");
    }

    const { data, error } = await supabase
      .from("approval_policy")
      .update(input)
      .select("*")
      .single();

    if (error) throw error;
    return Response.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
