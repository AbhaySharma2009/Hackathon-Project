import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/errors";
import { requireSession } from "@/lib/api/session";
import type { OrgNode } from "@/lib/types";

/**
 * GET /api/org-chart
 *
 * Returns the full org hierarchy as a nested tree. The RPC does all the
 * recursion; this endpoint just adds the session check and returns the JSON.
 */
export async function GET() {
  try {
    const { supabase } = await requireSession();

    const { data, error } = await supabase.rpc("get_org_tree");
    if (error) throw error;

    // The tree cuts a cyclic branch to stay finite, so it is checked separately:
    // the chart should say when it is showing fewer people than the company has.
    const { data: health } = await supabase.rpc("org_tree_health");

    return NextResponse.json({
      data: data as OrgNode[],
      meta: {
        generated_at: new Date().toISOString(),
        ...(health as { missing?: number; node_count?: number; active_count?: number } | null),
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}