import { NextResponse } from "next/server";
import { ApiError, toErrorResponse } from "@/server/api/errors";
import { requireRole } from "@/server/api/session";
import { createAdminClient } from "@/server/supabase/admin";

/**
 * POST /api/alerts/refresh
 *
 * Runs `generate_alerts()` and `generate_approval_alerts()` and reports how many
 * new alerts each produced.
 *
 * Three deliberate choices:
 *   - The generators are not granted to `authenticated`, so this route uses the
 *     service-role client. That key stays server-only (`server-only` in
 *     `server/supabase/admin.ts`) and never reaches a client bundle.
 *   - The rules are idempotent, so calling this on every dashboard load is safe:
 *     a condition that already has an alert inserts nothing.
 *   - Phase 3.5's overdue rule is keyed per (request, level), so an approval that
 *     stays pending past the threshold alerts the approver once, not once per
 *     refresh.
 */

/** Working days a step may sit before the approver is nudged. */
const APPROVAL_OVERDUE_DAYS = 2;

export async function POST() {
  try {
    // Generating alerts for other people is a privileged action: an employee
    // would learn their manager's or HR's view of the organisation.
    await requireRole("manager", "hr", "admin");

    const admin = createAdminClient();

    const { data, error } = await admin.rpc("generate_alerts");

    if (error) {
      console.error("[alerts] generate_alerts failed", error);
      throw new ApiError("VALIDATION", "Could not refresh alerts right now.");
    }

    // A failure here must not lose the first batch, so it is reported rather than
    // thrown: the dashboard's other alerts are still worth refreshing.
    const { data: overdue, error: overdueError } = await admin.rpc("generate_approval_alerts", {
      p_threshold_days: APPROVAL_OVERDUE_DAYS,
    });

    if (overdueError) {
      console.error("[alerts] generate_approval_alerts failed", overdueError);
    }

    return NextResponse.json({
      data: {
        created: Number(data ?? 0),
        approval_overdue: Number(overdue ?? 0),
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
