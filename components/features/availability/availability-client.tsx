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
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
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
import { PageHeader } from "@/components/design/page-header";
import { KpiCard } from "@/components/design/kpi-card";
import { ErrorState, InlineError } from "@/components/design/states";
import { KpiSkeleton } from "@/components/design/loaders";

/**
 * Tailwind needs literal class strings, so the tone palette is a lookup. The
 * colours come from the app's semantic success/warning/destructive tokens rather
 * than fixed emerald/amber/red, and every tone also carries an icon and a word —
 * the heatmap has to stay readable for someone who cannot separate the hues.
 */
const TONE_CELL: Record<Tone, string> = {
  full: "border-success/40 bg-success/10 text-success-foreground",
  low: "border-warning/50 bg-warning/12 text-warning-foreground",
  critical: "border-destructive/45 bg-destructive/10 text-destructive",
};

const TONE_ICON: Record<Tone, typeof CheckCircle2> = {
  full: CheckCircle2,
  low: AlertTriangle,
  critical: CircleAlert,
};

const TONE_WORD: Record<Tone, string> = {
  full: "Good",
  low: "Low",
  critical: "Critical",
};

type Tone = "full" | "low" | "critical";

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
      <div className="space-y-6">
        <PageHeader title="Team Availability" />
        <ErrorState
          title="We couldn't load team availability"
          message={error}
          onRetry={() => {
            setRefreshing(true);
            setError(null);
            void load()
              .catch((err: Error) => setError(err.message))
              .finally(() => setRefreshing(false));
          }}
          retrying={refreshing}
        />
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team Availability"
        description={
          <>
            {SCOPE_LABEL[data.scope.basis]} · {formatDate(data.from)} – {formatDate(data.to)} ·{" "}
            {span} days
            {loadedAt ? (
              <span className="ml-1">· updated {new Date(loadedAt).toLocaleTimeString("en-IN")}</span>
            ) : null}
          </>
        }
        actions={
        <div className="flex flex-wrap items-center gap-2">
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
        }
      />

      {error ? <InlineError message={error} /> : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          index={0}
          icon={Users}
          tone="neutral"
          label="People in scope"
          value={data.summary.team_size}
          hint={
            data.scope.basis === "team"
              ? "You, plus your direct reports"
              : "Active employees counted by the database"
          }
        />
        <KpiCard
          index={1}
          icon={CheckCircle2}
          tone={
            data.summary.average_availability_pct < LOW_AVAILABILITY_PCT ? "warning" : "success"
          }
          label="Average availability"
          value={`${data.summary.average_availability_pct}%`}
          hint="Mean across working days in range"
        />
        <KpiCard
          index={2}
          icon={CircleAlert}
          tone={
            data.summary.worst_day
              ? KPI_TONE[availabilityTone(data.summary.worst_day.availability_pct)]
              : "neutral"
          }
          label="Worst day"
          value={data.summary.worst_day ? `${data.summary.worst_day.availability_pct}%` : "—"}
          hint={
            data.summary.worst_day
              ? `${formatDate(data.summary.worst_day.date)} · ${data.summary.worst_day.names_on_leave.length} away`
              : "No working day in range"
          }
        />
        <KpiCard
          index={3}
          icon={AlertTriangle}
          tone={data.summary.days_below_threshold > 0 ? "warning" : "success"}
          label="Days needing cover"
          value={data.summary.days_below_threshold}
          hint={`Below ${LOW_AVAILABILITY_PCT}% available`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarRange className="size-5 text-muted-foreground" aria-hidden />
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
                const level = availabilityTone(day.availability_pct);
                const tone = day.is_weekend
                  ? "border-border bg-muted/40 text-muted-foreground"
                  : TONE_CELL[level];
                const ToneIcon = TONE_ICON[level];

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
                        className={`w-[5.5rem] rounded-lg border px-2 py-2 text-center transition-shadow duration-150 hover:shadow-sm ${tone}`}
                      >
                        <p className="text-2xs leading-tight font-medium tracking-wide uppercase opacity-75">
                          {weekday(day.date)} {formatDate(day.date)}
                        </p>
                        <p className="tabular mt-0.5 flex items-center justify-center gap-1 text-base leading-tight font-semibold">
                          {day.is_weekend ? (
                            <span aria-hidden>—</span>
                          ) : (
                            <>
                              <ToneIcon className="size-3.5" aria-hidden />
                              {day.availability_pct}%
                            </>
                          )}
                        </p>
                        {/* The tone in words, so the heatmap is not colour-only. */}
                        <p className="text-2xs leading-tight opacity-80">
                          {day.is_weekend
                            ? "Weekend"
                            : day.names_on_leave.length === 0
                              ? "Everyone in"
                              : `${day.names_on_leave.length} away`}
                        </p>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="font-medium">
                        {day.is_weekend
                          ? "Weekend — not counted as a risk"
                          : `${TONE_WORD[level]} coverage: ${day.available_count} of ${day.team_size} available`}
                      </p>
                      <p className="text-sm">
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
          {/* The mapping is stated, not left to the colours. */}
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4 text-sm">
            <span className="font-medium">Key</span>
            {(["full", "low", "critical"] as const).map((level) => {
              const Icon = TONE_ICON[level];
              return (
                <span key={level} className="inline-flex items-center gap-1.5">
                  <span
                    className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium ${TONE_CELL[level]}`}
                  >
                    <Icon className="size-3" aria-hidden />
                    {TONE_WORD[level]}
                  </span>
                  <span className="text-muted-foreground">
                    {level === "full"
                      ? `${LOW_AVAILABILITY_PCT}%+ available`
                      : level === "low"
                        ? "Below threshold"
                        : "Needs cover"}
                  </span>
                </span>
              );
            })}
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                —
              </span>
              <span className="text-muted-foreground">Weekend</span>
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5" aria-hidden />
            Working days below {LOW_AVAILABILITY_PCT}%
          </CardTitle>
          <CardDescription>
            The days most likely to need cover, with everyone already away.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {attention.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3.5 py-3 text-sm text-success-foreground">
              <CheckCircle2 className="size-4 shrink-0" aria-hidden />
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

const KPI_TONE: Record<Tone, "success" | "warning" | "danger"> = {
  full: "success",
  low: "warning",
  critical: "danger",
};

function AvailabilitySkeleton() {
  return (
    <div className="space-y-6">
      {/* The heading is rendered during loading too, so the page always has
          exactly one h1 — a screen reader is not handed a title-less document
          while the figures are still being read. */}
      <PageHeader title="Team Availability" description="Loading your team's coverage…" />
      <div className="space-y-2.5" aria-hidden>
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <KpiSkeleton />
      <div className="rounded-xl border bg-card p-5">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="mt-2 h-4 w-96 max-w-full" />
        <div className="mt-5 flex flex-wrap gap-1.5">
          {Array.from({ length: 14 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-[5.5rem] rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
