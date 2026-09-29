"use client";

/**
 * "Attention needed" — the alerts that apply to the viewer, on the dashboard.
 *
 * The bell in the topbar already carries these; putting the unread ones on the
 * dashboard too means a manager sees a stale pending request or a coverage gap
 * without opening anything. The set is the same `/api/alerts` payload, so RLS
 * decides it and a manager cannot see another team's alerts by opening this card.
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCheck, ShieldCheck } from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import type { AlertsFeed } from "@/shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const SEVERITY_VARIANT = {
  info: "secondary",
  warning: "outline",
  critical: "destructive",
} as const;

export function AlertsCard() {
  const [feed, setFeed] = useState<AlertsFeed | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await apiFetch<{ data: AlertsFeed }>("/api/alerts", { signal });
    setFeed(response.data);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [load]);

  async function markAllRead() {
    const unread = (feed?.alerts ?? []).filter((alert) => !alert.is_read);
    setBusy(true);
    try {
      // Sequential rather than parallel: each PATCH is a small row write and
      // there are never many, so this avoids a burst against a busy dashboard.
      for (const alert of unread) {
        await apiFetch(`/api/alerts/${alert.id}`, {
          method: "PATCH",
          body: JSON.stringify({ is_read: true }),
        });
      }
      await load();
    } catch {
      /* leave the list as it is; the next refresh reconciles it */
    } finally {
      setBusy(false);
    }
  }

  const alerts = feed?.alerts ?? [];
  const unread = alerts.filter((alert) => !alert.is_read);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShieldCheck className="size-5" aria-hidden />
              Attention needed
            </CardTitle>
            <CardDescription>
              Coverage gaps and stale decisions raised by the rule checks.
            </CardDescription>
          </div>
          {unread.length > 0 ? (
            <Button variant="outline" size="sm" onClick={markAllRead} disabled={busy}>
              <CheckCheck aria-hidden />
              Mark all read
            </Button>
          ) : null}
        </div>
      </CardHeader>

      <CardContent>
        {alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing needs your attention right now.
          </p>
        ) : (
          <ul className="space-y-2">
            {alerts.map((alert) => (
              <li
                key={alert.id}
                data-slot="dashboard-alert"
                data-type={alert.type}
                data-severity={alert.severity}
                data-read={alert.is_read ? "true" : "false"}
                className={`flex items-start justify-between gap-3 rounded-md border p-3 text-sm ${
                  alert.is_read ? "text-muted-foreground" : ""
                }`}
              >
                <span>{alert.message}</span>
                <Badge
                  variant={SEVERITY_VARIANT[alert.severity as keyof typeof SEVERITY_VARIANT] ?? "secondary"}
                >
                  {alert.severity}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
