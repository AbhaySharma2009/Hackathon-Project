import { NextResponse } from "next/server";
import { toErrorResponse } from "@/server/api/errors";
import { requireSession } from "@/server/api/session";
import type { Alert, AlertsFeed } from "@/shared/types";

/** Alerts about a date that has already passed are noise, not information. */
const ALERT_HORIZON_DAYS = 45;
const MAX_ALERTS = 50;

/**
 * GET /api/alerts
 *
 * The alert bell for the signed-in employee.
 *
 * RLS decides what is visible — org-wide alerts, plus the ones scoped to the
 * viewer, plus everything for HR — so this route does not filter on ownership and
 * cannot widen the set. It only drops alerts whose date has passed, which is a
 * freshness concern rather than an access one. Reads are not marked read:
 * dismissing is an explicit PATCH, so a refresh never silently swallows an alert
 * the user has not looked at.
 */
export async function GET() {
  try {
    const { supabase } = await requireSession();

    const { data, error } = await supabase
      .from("alerts")
      .select("id, scope_employee_id, type, severity, message, related_date, created_at, is_read")
      .order("created_at", { ascending: false })
      .limit(MAX_ALERTS);

    if (error) throw error;

    const cutoff = new Date(
      Date.now() - ALERT_HORIZON_DAYS * 86_400_000,
    ).toISOString().slice(0, 10);

    const alerts = ((data ?? []) as Alert[]).filter(
      (alert) => !alert.related_date || alert.related_date >= cutoff,
    );

    const feed: AlertsFeed = {
      alerts,
      unread_count: alerts.filter((alert) => !alert.is_read).length,
      generated_at: new Date().toISOString(),
    };

    return NextResponse.json({
      data: feed,
      meta: { horizon_days: ALERT_HORIZON_DAYS },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
