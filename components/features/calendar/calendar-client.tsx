"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, SlidersHorizontal, X } from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import { createClient } from "@/shared/supabase-client";
import { LEAVE_TYPES, LEAVE_TYPE_LABEL } from "@/server/leave";
import type { CalendarLeave, LeaveType } from "@/shared/types";
import { cn } from "@/shared/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PageHeader } from "@/components/design/page-header";
import { EmptyState, ErrorState, InlineError } from "@/components/design/states";
import { LoadingRegion } from "@/components/design/loaders";
import { StatusBadge, statusMeta } from "@/components/design/status-badge";

/**
 * One colour per leave type, app-wide.
 *
 * The old palette was four hardcoded Tailwind hues chosen inside this file, so a
 * bar here never matched the same type anywhere else. The tokens come from the
 * categorical chart palette, which is already light/dark aware, and `unpaid`
 * stays neutral because it is tracked differently from the allocated types.
 *
 * `rail` is a solid bar on the leading edge of a span: it is the one part of a
 * bar that survives truncation, so a leave that runs past the cell edge still
 * announces its type.
 */
const LEAVE_TYPE_STYLE: Record<LeaveType, { bar: string; dot: string; rail: string }> = {
  casual: { bar: "border-chart-1/40 bg-chart-1/10", dot: "bg-chart-1", rail: "bg-chart-1" },
  sick: { bar: "border-chart-4/40 bg-chart-4/10", dot: "bg-chart-4", rail: "bg-chart-4" },
  annual: { bar: "border-chart-2/45 bg-chart-2/12", dot: "bg-chart-2", rail: "bg-chart-2" },
  unpaid: {
    bar: "border-border bg-muted",
    dot: "bg-muted-foreground",
    rail: "bg-muted-foreground",
  },
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Weekends are a texture, not a colour: a hairline hatch plus a barely-there
 * tint reads as "non-working" without competing with the leave bars for
 * attention, and it survives both themes because it mixes with `foreground`.
 */
const WEEKEND_HATCH =
  "repeating-linear-gradient(135deg, color-mix(in oklab, var(--color-foreground) 7%, transparent) 0 1px, transparent 1px 9px)";

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function toDate(value: string) {
  // Dates come back as `YYYY-MM-DD`; parse as local midnight so the grid lines up.
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatDay(iso: string) {
  return toDate(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function formatLong(iso: string) {
  return toDate(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
}

function formatRange(leave: CalendarLeave) {
  return leave.start_date === leave.end_date
    ? formatLong(leave.start_date)
    : `${formatDay(leave.start_date)} – ${formatDay(leave.end_date)}, ${toDate(leave.end_date).getFullYear()}`;
}

/** The 6x7 grid of cells covering the month, including the leading/trailing days. */
function buildMonthGrid(anchor: Date) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    return {
      date,
      inMonth: date.getMonth() === anchor.getMonth(),
      isWeekend: date.getDay() === 0 || date.getDay() === 6,
    };
  });
}

/**
 * A leave split into the grid runs it occupies. A request that starts before the
 * month or ends after it is clamped, and a run that crosses a week boundary is
 * emitted once per week so the bar visually wraps instead of disappearing.
 */
type BarSegment = {
  key: string;
  leave: CalendarLeave;
  startIndex: number;
  span: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
};

function buildBarSegments(leaves: CalendarLeave[], grid: { date: Date }[]): BarSegment[] {
  const segments: BarSegment[] = [];

  for (const leave of leaves) {
    const start = toDate(leave.start_date);
    const end = toDate(leave.end_date);

    // Which grid cells does this request actually cover (weekends included, so a
    // Mon–Fri request draws a continuous bar rather than five separate chips)?
    const covered = grid
      .map((cell, index) => ({ index, date: cell.date }))
      .filter(({ date }) => date >= start && date <= end);

    if (covered.length === 0) continue;

    // Group consecutive cells into per-week runs.
    let run: number[] = [];
    const runs: number[][] = [];
    for (const { index } of covered) {
      if (run.length === 0 || index === run[run.length - 1] + 1) run.push(index);
      else {
        runs.push(run);
        run = [index];
      }
    }
    if (run.length > 0) runs.push(run);

    runs.forEach((runIndices, runIndex) => {
      segments.push({
        key: `${leave.id}-${runIndex}`,
        leave,
        startIndex: runIndices[0],
        span: runIndices.length,
        continuesBefore: runIndex > 0,
        continuesAfter: runIndex < runs.length - 1,
      });
    });
  }

  // Order by start date so the bars read chronologically across the week.
  return segments.sort((a, b) => a.startIndex - b.startIndex);
}

/**
 * Segments of one week, packed into as few rows as possible.
 *
 * Previously every bar in a week sat in the same absolutely-positioned overlay
 * row, so two overlapping leaves drew on top of each other and hid one of them.
 * Each segment now gets its own lane, and the row only exists when a week has
 * leave in it.
 */
function packLanes(segments: BarSegment[]) {
  const lanes: BarSegment[][] = [];

  for (const segment of segments) {
    const lane = lanes.find(
      (candidate) =>
        candidate.every(
          (placed) =>
            placed.startIndex + placed.span <= segment.startIndex ||
            segment.startIndex + segment.span <= placed.startIndex,
        ),
    );
    if (lane) lane.push(segment);
    else lanes.push([segment]);
  }

  return lanes;
}

/**
 * A skeleton in the shape of the month grid, so the calendar does not jump when
 * the month's leave arrives.
 */
/**
 * The key states every mapping in words, so a colour is never the only thing
 * separating one leave type, a weekend or today from another. It is rendered in
 * both the grid and the small-screen list.
 */
function LeaveKey() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t px-4 py-3">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Leave type
      </span>
      {LEAVE_TYPES.map((type) => (
        <span key={type} className="flex items-center gap-1.5 text-sm">
          <span className={cn("size-2.5 rounded-full", LEAVE_TYPE_STYLE[type].dot)} aria-hidden />
          {LEAVE_TYPE_LABEL[type]}
        </span>
      ))}

      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <span
          className="size-2.5 rounded-[3px] border border-border bg-muted"
          style={{ backgroundImage: WEEKEND_HATCH }}
          aria-hidden
        />
        Weekend
      </span>
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <span className="size-2.5 rounded-full bg-primary ring-2 ring-primary/30" aria-hidden />
        Today
      </span>
    </div>
  );
}

function CalendarGridSkeleton() {
  return (
    <div aria-hidden>
      <div className="grid grid-cols-7 border-b bg-muted/40">
        {WEEKDAYS.map((day, index) => (
          <div
            key={day}
            className={cn(
              "border-r px-2 py-2 last:border-r-0",
              (index === 0 || index === 6) && "bg-muted/70",
            )}
          >
            <Skeleton className="h-3 w-7" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {Array.from({ length: 42 }).map((_, index) => {
          const column = index % 7;
          const week = Math.floor(index / 7);
          // A run of cells in the second week hints at a multi-day bar without
          // pretending to know which days are covered.
          const inHintedBar = week === 1 && column < 4;
          return (
            <div
              key={index}
              className={cn(
                "flex h-20 flex-col gap-1.5 border-b border-r border-border/70 p-1.5 last:border-r-0 sm:h-24",
                (column === 0 || column === 6) && "bg-muted/40",
              )}
            >
              <Skeleton className="size-7 shrink-0 rounded-full" />
              {inHintedBar ? (
                <Skeleton
                  className="mt-auto h-7 w-full rounded-md"
                  style={{ opacity: 1 - column * 0.15 }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LeaveListSkeleton() {
  return (
    <ul className="divide-y" aria-hidden>
      {Array.from({ length: 4 }).map((_, index) => (
        <li key={index} className="flex items-center gap-3 px-4 py-3.5">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3.5 w-52" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
        </li>
      ))}
    </ul>
  );
}

export function CalendarClient() {
  const [anchor, setAnchor] = useState(() => new Date());
  const [leaves, setLeaves] = useState<CalendarLeave[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [managers, setManagers] = useState<{ id: string; name: string }[]>([]);
  const [department, setDepartment] = useState("all");
  const [team, setTeam] = useState("all");
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Date | null>(null);
  /** The leave whose details are open, from a bar or from a day's list. */
  const [openLeaveId, setOpenLeaveId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  // Identifies the month + filters a load belongs to, so `loading` is derived from
  // "have we fetched what is on screen yet" rather than toggled inside the effect.
  const scope = `${monthKey(anchor)}|${department}|${team}`;
  const loading = loadedScope !== scope;

  const grid = useMemo(() => buildMonthGrid(anchor), [anchor]);
  const today = useMemo(() => new Date(), []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const query = new URLSearchParams({ month: monthKey(anchor) });
      if (department !== "all") query.set("department", department);
      if (team !== "all") query.set("team", team);

      const response = await apiFetch<{ data: CalendarLeave[] }>(`/api/calendar?${query}`, {
        signal,
      });
      setLeaves(response.data);
      setError(null);
    },
    [anchor, department, team],
  );

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal)
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => setLoadedScope(scope));
    return () => controller.abort();
    // `scope` is derived from the two deps above, so it changes with them.
  }, [load, scope]);

  // A manager approving a request turns that row into 'approved', which is exactly
  // the calendar's source of truth, so the grid fills in without a reload.
  useEffect(() => {
    const channel = createClient()
      .channel("calendar-leaves")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "leave_requests" },
        () => {
          load().catch(() => {
            /* a failed background refresh keeps the current month on screen */
          });
        },
      )
      .subscribe();

    return () => {
      void channel.unsubscribe();
    };
  }, [load]);

  // The filter lists have to cover the whole org, not just the filtered result,
  // otherwise choosing one filter would remove the other options.
  useEffect(() => {
    const controller = new AbortController();
    apiFetch<{ data: { departments: string[]; managers: { id: string; name: string }[] } }>(
      "/api/meta/filters",
      { signal: controller.signal },
    )
      .then((response) => {
        setDepartments(response.data.departments);
        setManagers(response.data.managers);
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      });
    return () => controller.abort();
  }, []);

  // The filters and the team scope are both applied server-side in
  // `get_calendar_leaves`, so the response is already exactly what the grid
  // should draw — no second pass here.
  const visible = leaves;

  const weeks = useMemo(() => {
    const segments = buildBarSegments(visible, grid);
    return Array.from({ length: 6 }, (_, week) => ({
      week,
      days: grid.slice(week * 7, week * 7 + 7),
      lanes: packLanes(
        segments.filter((segment) => Math.floor(segment.startIndex / 7) === week),
      ),
    }));
  }, [visible, grid]);

  const selectedLeaves = useMemo(
    () =>
      selected
        ? visible.filter((leave) => {
            const start = toDate(leave.start_date);
            const end = toDate(leave.end_date);
            return selected >= start && selected <= end;
          })
        : [],
    [selected, visible],
  );

  const openLeave = useMemo(
    () => (openLeaveId ? (visible.find((leave) => leave.id === openLeaveId) ?? null) : null),
    [openLeaveId, visible],
  );

  /** Chronological list of the month's leave, used by the small-screen layout. */
  const monthLeaves = useMemo(
    () =>
      [...visible].sort(
        (a, b) =>
          a.start_date.localeCompare(b.start_date) ||
          a.employee_name.localeCompare(b.employee_name),
      ),
    [visible],
  );

  const monthLabel = anchor.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const filtersActive = department !== "all" || team !== "all";
  const noLeaves = !loading && !error && visible.length === 0;
  // A failed background refresh should not wipe a month that is already on
  // screen, so the full-page error is only used when there is nothing to show.
  const blockingError = Boolean(error) && (loading || visible.length === 0);

  const retry = () => {
    setRetrying(true);
    load()
      .catch(() => {
        /* `load` failures surface through `error` */
      })
      .finally(() => setRetrying(false));
  };

  const openDetails = (leave: CalendarLeave) =>
    setOpenLeaveId((current) => (current === leave.id ? null : leave.id));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leave Calendar"
        description="Approved and pending leave across the organisation. Select a day to see who is out, or open a leave for the full detail."
        actions={
          <>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setAnchor((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              aria-label="Previous month"
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Button>

            <span
              className="min-w-32 text-center text-card-title font-semibold tabular"
              aria-live="polite"
            >
              {monthLabel}
            </span>

            <Button
              variant="outline"
              size="icon"
              onClick={() => setAnchor((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
              aria-label="Next month"
            >
              <ChevronRight className="size-4" aria-hidden />
            </Button>

            <Button variant="secondary" onClick={() => setAnchor(new Date())}>
              Today
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <SlidersHorizontal className="size-3.5" aria-hidden />
            Filters
          </span>

          <Select value={team} onValueChange={(value) => setTeam(value ?? "all")}>
            <SelectTrigger className="w-full sm:w-44" aria-label="Filter by team">
              <SelectValue placeholder="All teams" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All teams</SelectItem>
              {managers.map((manager) => (
                <SelectItem key={manager.id} value={manager.id}>
                  {manager.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={department} onValueChange={(value) => setDepartment(value ?? "all")}>
            <SelectTrigger className="w-full sm:w-48" aria-label="Filter by department">
              <SelectValue placeholder="All departments" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {departments.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {filtersActive ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDepartment("all");
                setTeam("all");
              }}
            >
              <X className="size-4" aria-hidden />
              Clear
            </Button>
          ) : null}

          <span className="ml-auto text-sm text-muted-foreground" aria-live="polite">
            {loading
              ? `Loading ${monthLabel}…`
              : `${visible.length} ${visible.length === 1 ? "request" : "requests"} in ${monthLabel}`}
          </span>
        </div>
      </PageHeader>

      {loading ? <LoadingRegion label={`Loading leave for ${monthLabel}`} /> : null}

      {blockingError ? (
        <ErrorState message={error} onRetry={retry} retrying={retrying || loading} />
      ) : error ? (
        <InlineError message={error} onRetry={retry} />
      ) : noLeaves ? (
        <EmptyState
          icon={CalendarDays}
          title={`No leave in ${monthLabel}`}
          description={
            filtersActive
              ? "No one matches the current team and department filters. Clear them to see the whole organisation."
              : "Nobody has leave booked this month."
          }
          action={
            filtersActive ? (
              <Button
                variant="outline"
                onClick={() => {
                  setDepartment("all");
                  setTeam("all");
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Card className="hidden overflow-hidden md:block">
            <CardContent className="p-0">
              {loading ? (
                <CalendarGridSkeleton />
              ) : (
                <>
                  <div className="grid grid-cols-7 border-b bg-muted/40">
                    {WEEKDAYS.map((day, index) => (
                      <div
                        key={day}
                        className={cn(
                          "border-r px-2 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground last:border-r-0",
                          (index === 0 || index === 6) && "bg-muted/70 text-foreground/70",
                        )}
                        style={
                          index === 0 || index === 6 ? { backgroundImage: WEEKEND_HATCH } : undefined
                        }
                      >
                        {day}
                      </div>
                    ))}
                  </div>

                  <TooltipProvider delay={120}>
                    <div className="divide-y">
                      {weeks.map(({ week, days, lanes }) => (
                        <div key={week} className="animate-of-fade-in">
                          <div className="grid grid-cols-7">
                            {days.map(({ date, inMonth, isWeekend }, index) => {
                              const isToday = sameDay(date, today);
                              const isSelected = selected ? sameDay(selected, date) : false;
                              return (
                                <button
                                  key={`${week}-${index}`}
                                  type="button"
                                  onClick={() => setSelected(date)}
                                  aria-label={`${date.toLocaleDateString("en-IN", {
                                    weekday: "long",
                                    day: "numeric",
                                    month: "long",
                                  })}${isToday ? ", today" : ""}${isWeekend ? ", weekend" : ""}`}
                                  aria-pressed={isSelected}
                                  style={
                                    isWeekend ? { backgroundImage: WEEKEND_HATCH } : undefined
                                  }
                                  className={cn(
                                    "flex h-20 flex-col items-start gap-1 border-r border-border/70 p-1.5 text-left transition-colors duration-150 last:border-r-0 hover:bg-accent/40 sm:h-24",
                                    isWeekend && "bg-muted/40",
                                    !inMonth && "text-muted-foreground/50",
                                    isSelected && "bg-accent/60 ring-2 ring-inset ring-primary/40",
                                    isToday && "bg-primary/6 ring-2 ring-inset ring-primary",
                                  )}
                                >
                                  <span
                                    className={cn(
                                      "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs tabular",
                                      isToday
                                        ? "bg-primary font-semibold text-primary-foreground"
                                        : "text-muted-foreground",
                                    )}
                                  >
                                    {date.getDate()}
                                  </span>
                                  {isToday ? (
                                    <span className="text-2xs font-semibold uppercase leading-none tracking-wide text-primary">
                                      Today
                                    </span>
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>

                          {lanes.map((lane, laneIndex) => (
                            <div key={`${week}-lane-${laneIndex}`} className="grid grid-cols-7">
                              {lane.map((segment) => {
                                const { leave, span, continuesBefore, continuesAfter } = segment;
                                const style = LEAVE_TYPE_STYLE[leave.leave_type];
                                const status = statusMeta(leave.status);
                                const StatusIcon = status.icon;
                                const isOpen = openLeaveId === leave.id;
                                return (
                                  <Tooltip key={segment.key}>
                                    <TooltipTrigger
                                      type="button"
                                      aria-label={`${leave.employee_name}, ${LEAVE_TYPE_LABEL[leave.leave_type]} leave, ${formatRange(leave)}, ${Number(leave.days)} ${Number(leave.days) === 1 ? "day" : "days"}. Open details.`}
                                      aria-expanded={isOpen}
                                      onClick={() => openDetails(leave)}
                                      style={{ gridColumn: `${segment.startIndex + 1} / span ${span}` }}
                                      className={cn(
                                        "mx-0.5 my-0.5 flex h-7 min-w-0 items-center gap-1.5 border text-left text-xs transition-[box-shadow,border-color] duration-150 hover:shadow-md",
                                        style.bar,
                                        continuesBefore ? "ml-0 rounded-l-none" : "rounded-l-md",
                                        continuesAfter ? "mr-0 rounded-r-none" : "rounded-r-md",
                                        isOpen && "shadow-md ring-2 ring-foreground/30",
                                      )}
                                    >
                                      <span
                                        className={cn(
                                          "h-4 w-1 shrink-0 self-stretch rounded-full",
                                          style.rail,
                                          continuesBefore && "opacity-40",
                                        )}
                                        aria-hidden
                                      />
                                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                                        {leave.employee_name}
                                      </span>
                                      <span className="shrink-0 text-xs font-medium tabular text-muted-foreground">
                                        {Number(leave.days) === 1 ? "1d" : `${Number(leave.days)}d`}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent
                                      side="top"
                                      className="max-w-72 flex-col items-start gap-1 p-3 text-left"
                                    >
                                      <p className="text-sm font-semibold">{leave.employee_name}</p>
                                      <p className="text-xs opacity-80">{leave.employee_department}</p>
                                      <p className="mt-1 flex items-center gap-1.5 text-xs">
                                        <span className={cn("size-2 rounded-full", style.dot)} aria-hidden />
                                        {LEAVE_TYPE_LABEL[leave.leave_type]} · {Number(leave.days)}{" "}
                                        {Number(leave.days) === 1 ? "working day" : "working days"}
                                      </p>
                                      <p className="text-xs tabular opacity-80">{formatRange(leave)}</p>
                                      {/* The popup is dark, so the status is stated with
                                          its icon and word rather than a soft badge. */}
                                      <p className="mt-0.5 flex items-center gap-1.5 text-xs">
                                        <StatusIcon className="size-3.5" aria-hidden />
                                        {status.label}
                                      </p>
                                    </TooltipContent>
                                  </Tooltip>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </TooltipProvider>

                  <LeaveKey />
                </>
              )}
            </CardContent>
          </Card>

          {/* Below `md` seven columns cannot hold a readable name, so the month is
              given as a list instead of a squeezed grid. */}
          <Card className="overflow-hidden md:hidden">
            <CardContent className="p-0">
              <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Leave in {monthLabel}
                </p>
                <p className="text-sm text-muted-foreground">{visible.length} requests</p>
              </div>

              {loading ? (
                <LeaveListSkeleton />
              ) : monthLeaves.length === 0 ? (
                <EmptyState
                  icon={CalendarDays}
                  title="No leave this month"
                  description="Nobody has leave booked in this month."
                  className="border-0 py-10"
                />
              ) : (
                <ul className="divide-y">
                  {monthLeaves.map((leave) => {
                    const style = LEAVE_TYPE_STYLE[leave.leave_type];
                    const isOpen = openLeaveId === leave.id;
                    return (
                      <li key={leave.id}>
                        <button
                          type="button"
                          onClick={() => openDetails(leave)}
                          aria-expanded={isOpen}
                          className={cn(
                            "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-accent/40",
                            isOpen && "bg-accent/60",
                          )}
                        >
                          <span
                            className={cn("h-10 w-1 shrink-0 rounded-full", style.rail)}
                            aria-hidden
                          />
                          <Avatar>
                            {leave.employee_photo ? (
                              <AvatarImage src={leave.employee_photo} alt="" />
                            ) : (
                              <AvatarFallback>{initials(leave.employee_name)}</AvatarFallback>
                            )}
                          </Avatar>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {leave.employee_name}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground tabular">
                              {LEAVE_TYPE_LABEL[leave.leave_type]} · {formatRange(leave)} ·{" "}
                              {Number(leave.days)}{" "}
                              {Number(leave.days) === 1 ? "day" : "days"}
                            </span>
                          </span>
                          <StatusBadge status={leave.status} className="shrink-0" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              <LeaveKey />
            </CardContent>
          </Card>
        </>
      )}

      {/* Announced when the detail area changes in place. */}
      <p className="sr-only" role="status" aria-live="polite">
        {openLeave
          ? `Showing details for ${openLeave.employee_name}, ${LEAVE_TYPE_LABEL[openLeave.leave_type]} leave.`
          : selected
            ? `Showing everyone on leave on ${selected.toLocaleDateString("en-IN", { day: "numeric", month: "long" })}.`
            : ""}
      </p>

      {openLeave ? (
        <Card className="animate-of-rise border-l-4 border-l-primary">
          <CardContent className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <Avatar size="lg">
                  {openLeave.employee_photo ? (
                    <AvatarImage src={openLeave.employee_photo} alt="" />
                  ) : (
                    <AvatarFallback>{initials(openLeave.employee_name)}</AvatarFallback>
                  )}
                </Avatar>
                <div className="min-w-0">
                  <h2 className="truncate text-card-title font-semibold">
                    {openLeave.employee_name}
                  </h2>
                  <p className="truncate text-sm text-muted-foreground">
                    {openLeave.employee_department}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <StatusBadge status={openLeave.status} />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close leave details"
                  onClick={() => setOpenLeaveId(null)}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </div>
            </div>

            <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Leave type
                </dt>
                <dd className="mt-1.5 flex items-center gap-1.5 text-body">
                  <span
                    className={cn("size-2.5 rounded-full", LEAVE_TYPE_STYLE[openLeave.leave_type].dot)}
                    aria-hidden
                  />
                  {LEAVE_TYPE_LABEL[openLeave.leave_type]}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Dates
                </dt>
                <dd className="mt-1.5 text-body tabular">{formatRange(openLeave)}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Working days
                </dt>
                <dd className="mt-1.5 text-body tabular">{openLeave.days}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Requested on
                </dt>
                <dd className="mt-1.5 text-body tabular">
                  {openLeave.created_at ? formatDay(openLeave.created_at.slice(0, 10)) : "—"}
                </dd>
              </div>
            </dl>

            <div className="mt-5 border-t pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Reason
              </p>
              <p className="mt-1.5 text-body">
                {openLeave.reason?.trim() ? openLeave.reason : "No reason given."}
              </p>
              {openLeave.manager_comment ? (
                <>
                  <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Manager note
                  </p>
                  <p className="mt-1.5 text-body">{openLeave.manager_comment}</p>
                </>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {selected ? (
        <Card className="animate-of-rise">
          <CardContent className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-card-title font-semibold">
                {selected.toLocaleDateString("en-IN", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </h2>
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                Clear
              </Button>
            </div>

            {selectedLeaves.length === 0 ? (
              <EmptyState
                icon={CalendarDays}
                title="Nobody is on leave"
                description="No approved leave covers this day."
                className="mt-4 border-0 py-8"
              />
            ) : (
              <ul className="mt-4 space-y-2">
                {selectedLeaves.map((leave) => {
                  const style = LEAVE_TYPE_STYLE[leave.leave_type];
                  const isOpen = openLeaveId === leave.id;
                  return (
                    <li key={leave.id}>
                      <button
                        type="button"
                        onClick={() => openDetails(leave)}
                        aria-expanded={isOpen}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-lg border p-2.5 text-left transition-colors duration-150 hover:bg-accent/40",
                          isOpen && "bg-accent/60 ring-1 ring-primary/40",
                        )}
                      >
                        <span
                          className={cn("h-9 w-1 shrink-0 rounded-full", style.rail)}
                          aria-hidden
                        />
                        <Avatar size="sm">
                          {leave.employee_photo ? (
                            <AvatarImage src={leave.employee_photo} alt="" />
                          ) : (
                            <AvatarFallback>{initials(leave.employee_name)}</AvatarFallback>
                          )}
                        </Avatar>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {leave.employee_name}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground tabular">
                            {leave.employee_department} · {formatRange(leave)} ·{" "}
                            {Number(leave.days)}d
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <span
                            className={cn("size-2.5 rounded-full", style.dot)}
                            aria-hidden
                          />
                          {LEAVE_TYPE_LABEL[leave.leave_type]}
                        </span>
                        <StatusBadge status={leave.status} className="shrink-0" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
