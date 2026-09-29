import { NextResponse } from "next/server";
import { ApiError, toErrorResponse } from "@/server/api/errors";
import { requireRole } from "@/server/api/session";
import { createAdminClient } from "@/server/supabase/admin";

/**
 * POST /api/alerts/refresh
 *
 * Runs `generate_alerts()` and reports how many new alerts it produced.
 *
 * Two deliberate choices:
 *   - The generator is not granted to `authenticated`, so this route uses the
 *     service-role client. That key stays server-only (`server-only` in
 *     `server/supabase/admin.ts`) and never reaches a client bundle.
 *   - The rules are idempotent, so calling this on every dashboard load is safe:
 *     a condition that already has an unread alert inserts nothing.
 */
export async function POST() {
  try {
    // Generating alerts for other people is a privileged action: an employee
    // would learn their manager's or HR's view of the organisation.
    await requireRole("manager", "hr");

    const { data, error } = await createAdminClient().rpc("generate_alerts");

    if (error) {
      console.error("[alerts] generate_alerts failed", error);
      throw new ApiError("VALIDATION", "Could not refresh alerts right now.");
    }

    return NextResponse.json({ data: { created: Number(data ?? 0) } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
