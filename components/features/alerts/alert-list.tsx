"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BellRing,
  CalendarClock,
  CheckCheck,
  CircleAlert,
  Info,
  Wallet,
} from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import { loadAlertsFeed } from "@/shared/alerts-feed";
import type { Alert, AlertSeverity, AlertsFeed } from "@/shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/design/states";
import { ListSkeleton } from "@/components/design/loaders";
import { cn } from "@/shared/utils";

/**
 * The alert feed.
 *
 * Previously an alert was a grey sentence with a coloured word next to it, so
 * severity was carried by a badge and nothing else. Each alert now has a
 * severity icon, a title derived from its type, its own message, a relative
 * timestamp, a read state that is visible without hovering, and a link to the
 * request that raised it.
 */

const SEVERITY: Record<
  AlertSeverity,
  { label: string; icon: typeof Info; chip: string; rail: string }
> = {
  info: {
    label: "Info",
    icon: Info,
    chip: "bg-info/12 text-info-foreground ring-info/25",
    rail: "bg-info/60",
  },
  warning: {
    label: "Warning",
    icon: AlertTriangle,
    chip: "bg-warning/15 text-warning-foreground ring-warning/30",
    rail: "bg-warning",
  },
  critical: {
    label: "Critical",
    icon: CircleAlert,
    chip: "bg-destructive/10 text-destructive ring-destructive/30",
    rail: "bg-destructive",
  },
};

/** A human title per alert type. Unknown types fall back to the severity. */
const TYPE_TITLE: Record<string, string> = {
  leave_approved: "Leave approved",
  leave_rejected: "Leave rejected",
  leave_pending: "Request submitted",
  balance_low: "Leave balance running low",
  upcoming_leave: "Upcoming leave",
  team_absent: "Team coverage gap",
  approval_pending: "Waiting on your approval",
  approval_escalated: "Escalated to the next approver",
  approval_overdue: "Approval overdue",
};

function relativeTime(iso: string) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** The link an alert can offer, when it points at a specific request. */
function alertHref(alert: Alert) {
  if (alert.related_request_id) return "/my-leaves";
  if (alert.related_date) return "/calendar";
  return null;
}

export function AlertList({
  compact = false,
  showFilter = true,
}: {
  compact?: boolean;
  showFilter?: boolean;
}) {
  const [feed, setFeed] = useState<AlertsFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread" | AlertSeverity>("all");

  // The alert bell is already in the topbar and reads the same feed on mount, so
  // this goes through the shared loader rather than issuing a second identical
  // request. Marking something read does change the feed, so those reloads force
  // a fresh read.
  const load = useCallback(async (options: { force?: boolean } = {}) => {
    setFeed(await loadAlertsFeed(options));
    setError(null);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
      .catch((err: Error) => {
        setError(err.message);
      })
      .finally(() => setLoading(false));
  }, [load]);

  async function markAllRead() {
    const unread = (feed?.alerts ?? []).filter((alert) => !alert.is_read);
    if (unread.length === 0) return;
    setBusy(true);
    try {
      // Sequential: each PATCH is a small row write and there are never many, so
      // this avoids a burst of requests against a busy dashboard.
      for (const alert of unread) {
        await apiFetch(`/api/alerts/${alert.id}`, {
          method: "PATCH",
          body: JSON.stringify({ is_read: true }),
        });
      }
      await load({ force: true });
    } catch {
      /* leave the list as it is; the next refresh reconciles it */
    } finally {
      setBusy(false);
    }
  }

  async function markRead(id: string) {
    setBusy(true);
    try {
      await apiFetch(`/api/alerts/${id}`, { method: "PATCH", body: JSON.stringify({ is_read: true }) });
      await load({ force: true });
    } catch {
      /* a failed write is reconciled on the next refresh */
    } finally {
      setBusy(false);
    }
  }

  const alerts = useMemo(() => feed?.alerts ?? [], [feed]);
  const unreadCount = feed?.unread_count ?? 0;

  const visible = useMemo(() => {
    if (filter === "all") return alerts;
    if (filter === "unread") return alerts.filter((alert) => !alert.is_read);
    return alerts.filter((alert) => alert.severity === filter);
  }, [alerts, filter]);

  if (loading) return <ListSkeleton count={compact ? 2 : 4} />;

  if (error) {
    return (
      <ErrorState
        title="We couldn't load your alerts"
        message={error}
        onRetry={() => {
          setLoading(true);
          setError(null);
          void load().catch((err: Error) => setError(err.message)).finally(() => setLoading(false));
        }}
      />
    );
  }

  const FILTERS = [
    { value: "all" as const, label: "All", count: alerts.length },
    { value: "unread" as const, label: "Unread", count: unreadCount },
    { value: "critical" as const, label: "Critical", count: alerts.filter((a) => a.severity === "critical").length },
    { value: "warning" as const, label: "Warning", count: alerts.filter((a) => a.severity === "warning").length },
  ];

  return (
    <div className="space-y-4">
      {(showFilter || unreadCount > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {showFilter ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter alerts">
              {FILTERS.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  onClick={() => setFilter(entry.value)}
                  aria-pressed={filter === entry.value}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors duration-150",
                    filter === entry.value
                      ? "border-primary/30 bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {entry.label}
                  <span className="tabular text-xs text-muted-foreground">{entry.count}</span>
                </button>
              ))}
            </div>
          ) : (
            <span />
          )}

          {unreadCount > 0 ? (
            <Button variant="outline" size="sm" onClick={markAllRead} disabled={busy}>
              <CheckCheck aria-hidden />
              Mark all read
            </Button>
          ) : null}
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon={filter === "all" ? BellRing : Wallet}
          title={
            filter === "all"
              ? "Nothing needs your attention"
              : filter === "unread"
                ? "You're all caught up"
                : `No ${filter} alerts`
          }
          description={
            filter === "all"
              ? "Coverage gaps, expiring balances and approvals that are waiting on someone appear here as soon as the rule checks raise them."
              : "Try a different filter to see the rest of your notifications."
          }
        />
      ) : (
        <ul className={cn("space-y-2.5", compact && "space-y-2")}>
          {visible.map((alert) => {
            const severity = SEVERITY[(alert.severity as AlertSeverity) ?? "info"] ?? SEVERITY.info;
            const Icon = severity.icon;
            const href = alertHref(alert);
            return (
              <li
                key={alert.id}
                data-slot="alert-row"
                data-severity={alert.severity}
                data-read={alert.is_read ? "true" : "false"}
                className={cn(
                  "group/alert relative flex gap-3.5 overflow-hidden rounded-xl border bg-card p-4 transition-[box-shadow,border-color] duration-200",
                  alert.is_read ? "opacity-70" : "hover:border-primary/25 hover:shadow-sm",
                )}
              >
                {!alert.is_read ? (
                  <span
                    aria-hidden
                    className={cn("absolute inset-y-3 left-0 w-1 rounded-full", severity.rail)}
                  />
                ) : null}

                <span
                  className={cn(
                    "grid size-9 shrink-0 place-items-center rounded-lg ring-1",
                    severity.chip,
                  )}
                >
                  <Icon className="size-[1.1rem]" aria-hidden />
                </span>

                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-sm font-semibold">
                      {TYPE_TITLE[alert.type] ?? severity.label}
                    </p>
                    <Badge variant="outline" className="text-2xs">
                      {severity.label}
                    </Badge>
                    {!alert.is_read ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                        <span className="size-1.5 rounded-full bg-primary" aria-hidden />
                        New
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">{alert.message}</p>
                  <div className="flex flex-wrap items-center gap-3 pt-0.5 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarClock className="size-3.5" aria-hidden />
                      <time dateTime={alert.created_at}>{relativeTime(alert.created_at)}</time>
                    </span>
                    {href ? (
                      <Link
                        href={href}
                        className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                      >
                        View
                        <ArrowRight className="size-3.5" aria-hidden />
                      </Link>
                    ) : null}
                    {!alert.is_read ? (
                      <button
                        type="button"
                        onClick={() => void markRead(alert.id)}
                        disabled={busy}
                        className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <CheckCheck className="size-3.5" aria-hidden />
                        Mark read
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
