import { NextResponse } from "next/server";
import { toErrorResponse } from "@/server/api/errors";
import { requireSession } from "@/server/api/session";
import type { OrgNode } from "@/shared/types";

/**
 * GET /api/org-chart
 *
 * Returns the full org hierarchy as a nested tree. The RPC does all the
 * recursion; this endpoint just adds the session check and returns the JSON.
 */
export async function GET() {
  try {
    const { supabase } = await requireSession();

    // Both reads are independent: the tree cuts a cyclic branch to stay finite, so
    // it is checked separately, and the chart should say when it is showing fewer
    // people than the company has. Nothing in the health count depends on the
    // tree, so they are asked together rather than one round trip after another.
    const [tree, health] = await Promise.all([
      supabase.rpc("get_org_tree"),
      supabase.rpc("org_tree_health"),
    ]);

    if (tree.error) throw tree.error;

    return NextResponse.json({
      data: tree.data as OrgNode[],
      meta: {
        generated_at: new Date().toISOString(),
        ...(health.data as { missing?: number; node_count?: number; active_count?: number } | null),
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}