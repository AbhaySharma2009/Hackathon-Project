"use client";

/**
 * Team Availability — where the gaps are.
 *
 * The grid comes from `GET /api/availability`, whose ratios are computed by
 * `get_availability` in Postgres. This component decides nothing about
 * availability: it colours the numbers the database returned and names the people
 * it listed. The only threshold used here is the shared one in `@/server/insights`,
 * so the page and the tests agree on what "low" means.
 *
 * Scope is the server's to decide. A manager is pinned to their own reporting
 * line; HR defaults to the organisation and may narrow to a manager.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Users,
} from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import { createClient } from "@/shared/supabase-client";
import {
  LOW_AVAILABILITY_PCT,
  availabilityTone,
  dayCount,
} from "@/server/insights";
import type { TeamAvailability } from "@/shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** Tailwind needs literal class strings, so the tone palette is a lookup. */
const TONE_CELL: Record<"full" | "low" | "critical", string> = {
  full: "border-emerald-200 bg-emerald-50 text-emerald-900",
  low: "border-amber-200 bg-amber-50 text-amber-900",
  critical: "border-red-200 bg-red-50 text-red-900",
};

function toIso(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseIso(value: string) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function shift(value: string, days: number) {
  const date = parseIso(value);
  date.setDate(date.getDate() + days);
  return toIso(date);
}

function formatDate(value: string) {
  return parseIso(value).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function weekday(value: string) {
  return parseIso(value).toLocaleDateString("en-IN", { weekday: "short" });
}

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

/** The window a manager sees when they first land on the page. */
function initialRange() {
  const today = new Date();
  // Start on the most recent Monday, so the grid begins on a week boundary.
  const from = new Date(today);
  from.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return { from: toIso(from), to: toIso(new Date(from.getTime() + 27 * 86_400_000)) };
}

const SCOPE_LABEL: Record<TeamAvailability["scope"]["basis"], string> = {
  team: "your reporting line",
  department: "a department",
  organisation: "the whole organisation",
};

export function AvailabilityClient() {
  const [range, setRange] = useState(initialRange);
  const [data, setData] = useState<TeamAvailability | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const params = new URLSearchParams({ from: range.from, to: range.to });
      const response = await apiFetch<{ data: TeamAvailability }>(
        `/api/availability?${params.toString()}`,
        { signal },
      );
      setData(response.data);
      setLoadedAt(new Date().toISOString());
      setError(null);
    },
    [range.from, range.to],
  );

  // Loading is derived rather than tracked: the skeleton shows until the first
  // payload lands, and a later range change keeps the old grid on screen while
  // the new one is fetched instead of flashing back to a skeleton.
  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal).catch((err: Error) => {
      if (err.name !== "AbortError") setError(err.message);
    });
    return () => controller.abort();
  }, [load]);

  // An approval anywhere changes who is away, so the grid follows the same
  // signal the calendar uses. Realtime only prompts a refetch; the numbers still
  // come from the database.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("team-availability")
      .on("postgres_changes", { event: "*", schema: "public", table: "leave_requests" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "employees" }, refresh)
      .subscribe();

    function refresh() {
      load().catch(() => {
        /* keep the last good grid on screen if a background refresh fails */
      });
    }

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => {
      load().catch(() => {});
    }, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  async function regenerate() {
    setRefreshing(true);
    try {
      // Alerts are a separate concern from the grid, but a new alert usually
      // means a new absence, so the grid is refetched alongside it.
      await apiFetch<{ data: { created: number } }>("/api/alerts/refresh", { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refresh.");
    } finally {
      setRefreshing(false);
    }
  }

  const attention = useMemo(
    () =>
      (data?.days ?? []).filter(
        (day) => !day.is_weekend && day.availability_pct < LOW_AVAILABILITY_PCT,
      ),
    [data],
  );

  const span = data ? dayCount(data.from, data.to) : 0;

  if (!data && !error) return <AvailabilitySkeleton />;

  if (error && !data) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Team Availability</h1>
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Team Availability</h1>
          <p className="text-sm text-muted-foreground">
            {SCOPE_LABEL[data.scope.basis]} · {formatDate(data.from)} – {formatDate(data.to)} ·{" "}
            {span} days
            {loadedAt ? (
              <span className="ml-1">· updated {new Date(loadedAt).toLocaleTimeString("en-IN")}</span>
            ) : null}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRange((r) => ({ from: shift(r.from, -28), to: shift(r.to, -28) }))}
          >
            <ChevronLeft className="size-4" aria-hidden />
            Earlier
          </Button>
          <Button variant="outline" size="sm" onClick={() => setRange(initialRange())}>
            Today
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRange((r) => ({ from: shift(r.from, 28), to: shift(r.to, 28) }))}
          >
            Later
            <ChevronRight className="size-4" aria-hidden />
          </Button>
          <Button variant="outline" size="sm" onClick={regenerate} disabled={refreshing}>
            <RefreshCw className={refreshing ? "animate-spin" : undefined} aria-hidden />
            Check for risks
          </Button>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="People in scope"
          value={String(data.summary.team_size)}
          hint={
            data.scope.basis === "team"
              ? "You, plus your direct reports"
              : "Active employees counted by the database"
          }
        />
        <StatCard
          title="Average availability"
          value={`${data.summary.average_availability_pct}%`}
          hint="Mean across working days in range"
          tone={
            data.summary.average_availability_pct < LOW_AVAILABILITY_PCT ? "critical" : "full"
          }
        />
        <StatCard
          title="Worst day"
          value={
            data.summary.worst_day ? `${data.summary.worst_day.availability_pct}%` : "—"
          }
          hint={
            data.summary.worst_day
              ? `${formatDate(data.summary.worst_day.date)} · ${data.summary.worst_day.names_on_leave.length} away`
              : "No working day in range"
          }
          tone={data.summary.worst_day ? availabilityTone(data.summary.worst_day.availability_pct) : "full"}
        />
        <StatCard
          title="Days needing cover"
          value={String(data.summary.days_below_threshold)}
          hint={`Below ${LOW_AVAILABILITY_PCT}% available`}
          tone={data.summary.days_below_threshold > 0 ? "low" : "full"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <CalendarRange className="size-5" aria-hidden />
            Day by day
          </CardTitle>
          <CardDescription>
            Share of the team available on each day, from approved leave only. Weekends are
            dimmed and never counted as a risk.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TooltipProvider delay={120}>
            <div className="flex flex-wrap gap-1.5">
              {data.days.map((day) => {
                const tone = day.is_weekend
                  ? "border-border bg-muted/40 text-muted-foreground"
                  : TONE_CELL[availabilityTone(day.availability_pct)];

                return (
                  <Tooltip key={day.date}>
                    {/* The trigger is a real button for keyboard access, so the
                        cell is styled inside it and the chrome is reset. */}
                    <TooltipTrigger className="cursor-default border-0 bg-transparent p-0">
                      <div
                        data-slot="availability-day"
                        data-date={day.date}
                        data-weekend={day.is_weekend ? "true" : "false"}
                        data-availability-pct={day.availability_pct}
                        className={`w-[4.5rem] rounded-md border px-2 py-1.5 text-center ${tone}`}
                      >
                        <p className="text-[0.65rem] uppercase tracking-wide opacity-70">
                          {weekday(day.date)} {formatDate(day.date)}
                        </p>
                        <p className="text-sm font-semibold tabular-nums">
                          {day.availability_pct}%
                        </p>
                        <p className="truncate text-[0.65rem]">
                          {day.names_on_leave.length === 0
                            ? "—"
                            : day.names_on_leave.map(initials).join(" ")}
                        </p>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="font-medium">
                        {day.available_count} of {day.team_size} available
                      </p>
                      <p className="text-xs">
                        {day.names_on_leave.length === 0
                          ? "Nobody away"
                          : `Away: ${day.names_on_leave.join(", ")}`}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </TooltipProvider>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <AlertTriangle className="size-5" aria-hidden />
            Working days below {LOW_AVAILABILITY_PCT}%
          </CardTitle>
          <CardDescription>
            The days most likely to need cover, with everyone already away.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {attention.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
              <Users className="size-4" aria-hidden />
              No working day in this range drops below {LOW_AVAILABILITY_PCT}% availability.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Day</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                  <TableHead>Coverage</TableHead>
                  <TableHead>Away</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {attention.map((day) => (
                  <TableRow key={day.date}>
                    <TableCell className="font-medium tabular-nums">{day.date}</TableCell>
                    <TableCell className="text-muted-foreground">{weekday(day.date)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {day.available_count}/{day.team_size}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={TONE_CELL[availabilityTone(day.availability_pct)]}
                      >
                        {day.availability_pct}%
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {day.names_on_leave.join(", ") || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  title,
  value,
  hint,
  tone = "full",
}: {
  title: string;
  value: string;
  hint: string;
  tone?: "full" | "low" | "critical";
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p
          className={`text-xs ${tone === "full" ? "text-muted-foreground" : "text-amber-700"}`}
        >
          {hint}
        </p>
      </CardContent>
    </Card>
  );
}

function AvailabilitySkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
