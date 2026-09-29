"use client";

/**
 * HR dashboard. Every figure comes from `GET /api/dashboard/summary`, which
 * computes them in Postgres and applies the caller's scope: HR sees the whole
 * organisation, a manager sees their direct reports and themselves.
 *
 * Nothing is recalculated here — the charts render the payload as given, so what
 * is displayed is exactly what the database counted.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  Sparkles,
  TrendingDown,
  UserCheck,
  Users,
} from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { createClient } from "@/lib/supabase/client";
import { LEAVE_TYPE_LABEL } from "@/lib/leave";
import type { DashboardSummary, LeaveActivity } from "@/lib/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AvailabilityDonut,
  HeadcountByDepartmentChart,
  LeaveBalanceChart,
  LeaveUsageByDepartmentChart,
} from "@/components/dashboard/charts";

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function formatDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}

/** "3m ago" style stamps for the activity feed. */
function relativeTime(iso: string) {
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

const EVENT_LABEL: Record<LeaveActivity["event"], string> = {
  submitted: "submitted a request",
  approved: "was approved",
  rejected: "was rejected",
};

const EVENT_BADGE: Record<LeaveActivity["event"], "secondary" | "outline" | "destructive"> = {
  submitted: "secondary",
  approved: "outline",
  rejected: "destructive",
};

export function HrDashboardClient() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await apiFetch<{ data: DashboardSummary }>("/api/dashboard/summary", {
      signal,
    });
    setSummary(response.data);
    setLoadedAt(new Date().toISOString());
    setError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal)
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [load]);

  // A decision, a new request, or an employee joining must move the numbers on
  // this page without a refresh. Realtime is only the signal — the summary is
  // refetched, so what lands on screen is still what the database counted.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("hr-dashboard")
      .on("postgres_changes", { event: "*", schema: "public", table: "leave_requests" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "leave_balances" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "employees" }, refresh)
      .subscribe();

    function refresh() {
      load().catch(() => {
        /* a failed background refresh leaves the last good figures on screen */
      });
    }

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load]);

  // A slow poll is a safety net: if the realtime socket drops, the page should
  // still recover on its own rather than sit stale until a manual refresh.
  useEffect(() => {
    const timer = setInterval(() => {
      load().catch(() => {});
    }, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const maxTopDays = useMemo(
    () => Math.max(1, ...(summary?.top_leave_takers.map((t) => Number(t.days)) ?? [1])),
    [summary],
  );

  if (loading) return <DashboardSkeleton />;

  if (error || !summary) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">HR Dashboard</h1>
        <p className="text-sm text-destructive">{error ?? "Could not load the dashboard."}</p>
      </div>
    );
  }

  const { kpis, scope } = summary;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">HR Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {scope.org_wide
              ? "Workforce insights across the organisation."
              : "Your team's leave and workforce snapshot."}
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={scope.org_wide ? "default" : "secondary"}>
            {scope.org_wide ? "Organisation-wide" : "Team only"}
          </Badge>
          {loadedAt ? (
            <span>
              Updated{" "}
              {new Date(loadedAt).toLocaleTimeString("en-IN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          ) : null}
        </div>
      </div>

      {!scope.org_wide ? (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          You are seeing your own team only. Organisation-wide figures are restricted to HR.
        </p>
      ) : null}

      {/* ---- KPI cards ---- */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          icon={<Users className="size-4" aria-hidden />}
          label="Total headcount"
          value={kpis.headcount_total}
          hint="Active employees"
        />
        <KpiCard
          icon={<UserCheck className="size-4" aria-hidden />}
          label="On leave today"
          value={kpis.on_leave_today}
          hint={`of ${kpis.headcount_total} people`}
        />
        <KpiCard
          icon={<CalendarClock className="size-4" aria-hidden />}
          label="Pending approvals"
          value={kpis.pending_approvals}
          hint={
            kpis.pending_approvals === 0
              ? "Nothing waiting"
              : `Oldest waiting ${kpis.oldest_pending_age_days}d`
          }
        />
        <KpiCard
          icon={<TrendingDown className="size-4" aria-hidden />}
          label="Avg remaining balance"
          value={kpis.average_remaining_balance}
          suffix="days"
          hint="Per person, this year"
        />
      </div>

      {/* ---- Charts ---- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Headcount by department</CardTitle>
            <CardDescription>Active employees in each department.</CardDescription>
          </CardHeader>
          <CardContent>
            {summary.headcount_by_department.length === 0 ? (
              <EmptyState message="No active employees in scope." />
            ) : (
              <HeadcountByDepartmentChart data={summary.headcount_by_department} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Leave usage by department</CardTitle>
            <CardDescription>Days consumed this year, split by leave type.</CardDescription>
          </CardHeader>
          <CardContent>
            {summary.leave_balance_by_department.length === 0 ? (
              <EmptyState message="No balances recorded yet." />
            ) : (
              <LeaveUsageByDepartmentChart data={summary.leave_balance_by_department} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Leave balance summary</CardTitle>
            <CardDescription>Used against remaining, per leave type.</CardDescription>
          </CardHeader>
          <CardContent>
            <LeaveBalanceChart data={summary.leave_balance_by_type} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Who is out today</CardTitle>
            <CardDescription>Approved leave covering the current date.</CardDescription>
          </CardHeader>
          <CardContent>
            {kpis.on_leave_today === 0 ? (
              <EmptyState message="Everyone is in today." />
            ) : (
              <AvailabilityDonut data={summary.department_workforce} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---- Top leave takers + activity ---- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top leave takers</CardTitle>
            <CardDescription>Approved days in {summary.quarter.label}.</CardDescription>
          </CardHeader>
          <CardContent>
            {summary.top_leave_takers.length === 0 ? (
              <EmptyState message={`No approved leave in ${summary.quarter.label} yet.`} />
            ) : (
              <ul className="space-y-3">
                {summary.top_leave_takers.map((person) => (
                  <li key={person.employee_id} className="space-y-1.5">
                    <div className="flex items-center gap-3">
                      <Avatar size="sm">
                        {person.photo ? <AvatarImage src={person.photo} alt="" /> : null}
                        <AvatarFallback>{initials(person.name)}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{person.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {person.department} · {person.requests}{" "}
                          {person.requests === 1 ? "request" : "requests"}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm font-semibold tabular-nums">
                        {Number(person.days)}d
                      </span>
                    </div>
                    <Progress value={(Number(person.days) / maxTopDays) * 100} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-4" aria-hidden />
              Recent leave activity
            </CardTitle>
            <CardDescription>The last 10 submissions and decisions.</CardDescription>
          </CardHeader>
          <CardContent>
            {summary.recent_activity.length === 0 ? (
              <EmptyState message="No leave activity yet." />
            ) : (
              <ul className="space-y-3">
                {summary.recent_activity.map((item) => (
                  <li key={`${item.id}-${item.occurred_at}`} className="flex items-start gap-3">
                    <Avatar size="sm">
                      {item.employee_photo ? (
                        <AvatarImage src={item.employee_photo} alt="" />
                      ) : (
                        <AvatarFallback>{initials(item.employee_name)}</AvatarFallback>
                      )}
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">
                        <span className="font-medium">{item.employee_name}</span>{" "}
                        {EVENT_LABEL[item.event]}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {LEAVE_TYPE_LABEL[item.leave_type]} · {formatDate(item.start_date)}
                        {item.end_date !== item.start_date
                          ? ` – ${formatDate(item.end_date)}`
                          : ""}{" "}
                        · {Number(item.days)}d
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Badge variant={EVENT_BADGE[item.event]}>{item.event}</Badge>
                      <span className="text-[11px] text-muted-foreground">
                        {relativeTime(item.occurred_at)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---- Department workforce ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Department workforce</CardTitle>
          <CardDescription>Availability right now, and what is waiting for a decision.</CardDescription>
        </CardHeader>
        <CardContent>
          {summary.department_workforce.length === 0 ? (
            <EmptyState message="No departments in scope." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Department</TableHead>
                  <TableHead className="text-right">Headcount</TableHead>
                  <TableHead className="text-right">On leave</TableHead>
                  <TableHead className="w-48">Availability</TableHead>
                  <TableHead className="text-right">Pending</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.department_workforce.map((row) => (
                  <TableRow key={row.department}>
                    <TableCell className="font-medium">{row.department}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.headcount}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.on_leave_today > 0 ? (
                        <span className="text-amber-600 dark:text-amber-400">
                          {row.on_leave_today}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Progress value={Number(row.availability_pct)} className="flex-1" />
                        <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {Number(row.availability_pct)}%
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.pending_requests > 0 ? (
                        <Badge variant="secondary">{row.pending_requests}</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ---- Later-phase placeholders ---- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4 text-muted-foreground" aria-hidden />
              Alerts
            </CardTitle>
            <CardDescription>
              Balance warnings and upcoming-absence alerts land in Phase 6.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Nothing to show yet.</p>
          </CardContent>
        </Card>

        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4 text-muted-foreground" aria-hidden />
              Smart HR Query
            </CardTitle>
            <CardDescription>Ask the workforce data a question in plain English — Phase 8.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              The query box will only ever call the same role-scoped functions this
              page already uses.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  hint,
  suffix,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  hint: string;
  suffix?: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="text-muted-foreground">{icon}</span>
          {label}
        </div>
        <p className="text-3xl font-semibold tracking-tight tabular-nums">
          {Number(value)}
          {suffix ? (
            <span className="ml-1 text-base font-normal text-muted-foreground">{suffix}</span>
          ) : null}
        </p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-72" />
        ))}
      </div>
    </div>
  );
}
