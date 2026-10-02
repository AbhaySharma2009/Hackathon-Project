"use client";

/**
 * The alert bell.
 *
 * Reads `GET /api/alerts`, which is already scoped by RLS: org-wide alerts, the
 * ones addressed to this employee, and everything for HR. Nothing here filters by
 * ownership, and dismissing is a separate PATCH so a refetch never silently marks
 * something the user has not actually read.
 *
 * Only leaders can generate alerts, so the refresh action is offered to
 * manager/HR only — the same rule `/api/alerts/refresh` enforces.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bell,
  Check,
  CircleAlert,
  Info,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import { loadAlertsFeed } from "@/shared/alerts-feed";
import { createClient } from "@/shared/supabase-client";
import type { AlertSeverity, AlertsFeed, AppRole } from "@/shared/types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";

/**
 * Severity is carried by an icon and a word, not by a background tint alone: the
 * same three states the full alert page uses, so a colour learned in one place
 * means the same thing in the other.
 */
const SEVERITY: Record<
  AlertSeverity,
  { icon: typeof Info; chip: string; word: string }
> = {
  info: { icon: Info, chip: "bg-info/12 text-info-foreground", word: "Info" },
  warning: { icon: AlertTriangle, chip: "bg-warning/15 text-warning-foreground", word: "Warning" },
  critical: { icon: CircleAlert, chip: "bg-destructive/10 text-destructive", word: "Critical" },
};

function relativeTime(iso: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function AlertBell({ appRole }: { appRole: AppRole }) {
  const [feed, setFeed] = useState<AlertsFeed | null>(null);
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const canGenerate = appRole === "manager" || appRole === "hr";

  // Mount reads through the shared loader, which collapses the bell's request
  // with anything else asking for the feed at the same moment — on the alerts
  // page the list mounts too. Anything that has changed the alerts forces a
  // fresh read instead.
  const load = useCallback(async (options: { force?: boolean } = {}) => {
    setFeed(await loadAlertsFeed(options));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch(() => {
      /* the bell is advisory: a failure leaves the counter at zero, not an error */
    });
  }, [load]);

  // A decision or a new absence changes what deserves an alert, so the bell
  // follows the same realtime signal as the rest of the app.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("alerts-bell")
      .on("postgres_changes", { event: "*", schema: "public", table: "alerts" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "leave_requests" }, refresh)
      .subscribe();

    function refresh() {
      load({ force: true }).catch(() => {});
    }

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load]);

  async function markRead(id: string, isRead: boolean) {
    // Optimistic: the badge should respond to the click, not to the round trip.
    setFeed((current) =>
      current
        ? {
            ...current,
            alerts: current.alerts.map((a) => (a.id === id ? { ...a, is_read: isRead } : a)),
            unread_count: isRead
              ? Math.max(0, current.unread_count - 1)
              : current.unread_count + 1,
          }
        : current,
    );

    try {
      await apiFetch(`/api/alerts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_read: isRead }),
      });
    } catch {
      load({ force: true }).catch(() => {});
    }
  }

  async function regenerate() {
    setRefreshing(true);
    try {
      await apiFetch("/api/alerts/refresh", { method: "POST" });
      await load({ force: true });
    } finally {
      setRefreshing(false);
    }
  }

  const unread = feed?.unread_count ?? 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            aria-label={unread > 0 ? `Alerts, ${unread} unread` : "Alerts"}
          />
        }
      >
        <Bell className="size-5" aria-hidden />
        {unread > 0 ? (
          <span
            data-slot="alert-count"
            className="absolute -right-0.5 -top-0.5 grid min-w-4.5 place-items-center rounded-full bg-destructive px-1 text-2xs leading-none font-semibold text-white ring-2 ring-background"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <p className="text-card-title font-semibold">
            Alerts
            {unread > 0 ? (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {unread} unread
              </span>
            ) : null}
          </p>
          {canGenerate ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={regenerate}
              disabled={refreshing}
              title="Re-run the rule checks now"
            >
              {refreshing ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <RefreshCw aria-hidden />
              )}
              Check now
            </Button>
          ) : null}
        </div>
        <Separator />

        <div className="scrollbar-slim max-h-96 overflow-y-auto">
          {!feed || feed.alerts.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Nothing needs your attention right now.
            </p>
          ) : (
            <ul>
              {feed.alerts.map((alert) => {
                const severity = (alert.severity as AlertSeverity) ?? "info";
                const Severity = SEVERITY[severity].icon;
                return (
                  <li key={alert.id} className="border-b last:border-b-0">
                    <div
                      data-slot="alert"
                      data-type={alert.type}
                      data-severity={severity}
                      data-read={alert.is_read ? "true" : "false"}
                      className={`flex gap-3 px-4 py-3 ${alert.is_read ? "opacity-60" : ""}`}
                    >
                      <span
                        className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg ${SEVERITY[severity].chip}`}
                        title={SEVERITY[severity].word}
                      >
                        <Severity className="size-4" aria-hidden />
                        <span className="sr-only">{SEVERITY[severity].word}</span>
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm leading-relaxed">{alert.message}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {SEVERITY[severity].word} · {relativeTime(alert.created_at)}
                          {alert.related_date ? ` · ${alert.related_date}` : ""}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0"
                        onClick={() => markRead(alert.id, !alert.is_read)}
                        aria-label={alert.is_read ? "Mark as unread" : "Mark as read"}
                        title={alert.is_read ? "Mark as unread" : "Mark as read"}
                      >
                        {alert.is_read ? (
                          <Bell className="size-3.5" aria-hidden />
                        ) : (
                          <Check className="size-3.5" aria-hidden />
                        )}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {canGenerate ? (
          <>
            <Separator />
            <div className="p-2">
              <Link
                href="/alerts"
                onClick={() => setOpen(false)}
                className="block rounded-md px-2 py-1.5 text-center text-sm font-medium text-primary transition-colors hover:bg-accent"
              >
                View all alerts
              </Link>
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
