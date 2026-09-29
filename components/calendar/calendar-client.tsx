"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { createClient } from "@/lib/supabase/client";
import { LEAVE_TYPES, LEAVE_TYPE_LABEL } from "@/lib/leave";
import type { CalendarLeave, LeaveType } from "@/lib/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Tailwind needs literal class strings, so the palette is a lookup table. */
const LEAVE_TYPE_STYLE: Record<LeaveType, { bar: string; dot: string }> = {
  casual: { bar: "bg-sky-500/85 border-sky-600", dot: "bg-sky-500" },
  sick: { bar: "bg-rose-500/85 border-rose-600", dot: "bg-rose-500" },
  annual: { bar: "bg-emerald-500/85 border-emerald-600", dot: "bg-emerald-500" },
  unpaid: { bar: "bg-amber-500/85 border-amber-600", dot: "bg-amber-500" },
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

  // Order by start date so the bars read chronologically down the week.
  return segments.sort((a, b) => a.startIndex - b.startIndex);
}

/** Rows of segments, one row per grid week. */
function segmentsByWeek(segments: BarSegment[]) {
  const rows = new Map<number, BarSegment[]>();
  for (const segment of segments) {
    const week = Math.floor(segment.startIndex / 7);
    const row = rows.get(week);
    if (row) row.push(segment);
    else rows.set(week, [segment]);
  }
  return rows;
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

  const segments = useMemo(() => buildBarSegments(visible, grid), [visible, grid]);
  const rows = useMemo(() => segmentsByWeek(segments), [segments]);

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

  const monthLabel = anchor.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leave Calendar</h1>
          <p className="text-sm text-muted-foreground">
            Approved leave across the organisation. Click a day to see who is out.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setAnchor((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
            aria-label="Previous month"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>

          <span className="min-w-40 text-center font-medium">{monthLabel}</span>

          <Button
            variant="outline"
            size="icon"
            onClick={() => setAnchor((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
            aria-label="Next month"
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>

          <Button variant="ghost" size="sm" onClick={() => setAnchor(new Date())}>
            Today
          </Button>

          <Select
            value={team}
            onValueChange={(value) => setTeam(value ?? "all")}
          >
            <SelectTrigger className="w-44" aria-label="Filter by team">
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
            <SelectTrigger className="w-48" aria-label="Filter by department">
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
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Card>
        <CardContent className="p-0">
          <div className="grid grid-cols-7 border-b bg-muted/40">
            {WEEKDAYS.map((day) => (
              <div key={day} className="px-2 py-2 text-xs font-medium text-muted-foreground">
                {day}
              </div>
            ))}
          </div>

          <div className="relative">
            {/* Day numbers sit behind the bars, so each week is one grid row. */}
            <div className="grid grid-cols-7">
              {grid.map(({ date, inMonth, isWeekend }, index) => {
                const isToday = sameDay(date, today);
                return (
                  <button
                    key={index}
                    type="button"
                    onClick={() => setSelected(date)}
                    aria-label={date.toLocaleDateString("en-IN", {
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                    })}
                    aria-pressed={selected ? sameDay(selected, date) : false}
                    className={`relative h-28 border-b border-r p-1 text-left align-top transition-colors hover:bg-accent/40 ${
                      isWeekend ? "bg-muted/30" : ""
                    } ${inMonth ? "" : "text-muted-foreground/40"}`}
                  >
                    <span
                      className={`inline-flex size-6 items-center justify-center rounded-full text-xs ${
                        isToday ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {date.getDate()}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Bars overlay the grid, one absolute row per week. */}
            <div className="pointer-events-none absolute inset-0">
              {Array.from({ length: 6 }).map((_, week) => (
                <div key={week} className="grid h-28 grid-cols-7">
                  {WEEKDAYS.map((day) => (
                    <div key={day} className="h-28 border-b border-r last:border-r-0" />
                  ))}
                </div>
              ))}

              {Array.from({ length: 6 }).map((_, week) => {
                const weekSegments = rows.get(week) ?? [];
                if (weekSegments.length === 0) return null;
                return (
                  <div
                    key={`bars-${week}`}
                    className="absolute grid w-full grid-cols-7"
                    style={{ top: `${week * 7}rem`, height: "7rem" }}
                  >
                    {weekSegments.map((segment) => {
                      const { leave, span, continuesBefore, continuesAfter } = segment;
                      const style = LEAVE_TYPE_STYLE[leave.leave_type];
                      return (
                        <div
                          key={segment.key}
                          className="px-0.5 pt-7"
                          style={{ gridColumn: `${segment.startIndex + 1} / span ${span}` }}
                        >
                          <div
                            title={`${leave.employee_name} · ${LEAVE_TYPE_LABEL[leave.leave_type]} · ${leave.start_date} → ${leave.end_date}`}
                            className={`flex h-6 items-center gap-1 overflow-hidden border px-1.5 text-[11px] leading-none text-white ${style.bar} ${
                              continuesBefore ? "rounded-l-none border-l-0" : "rounded-l-md"
                            } ${continuesAfter ? "rounded-r-none border-r-0" : "rounded-r-md"}`}
                          >
                            <span className="truncate font-medium">{leave.employee_name}</span>
                            <span className="ml-auto shrink-0 tabular-nums opacity-90">
                              {Number(leave.days) === 1 ? "1d" : `${Number(leave.days)}d`}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>

          {loading ? (
            <p className="border-t p-3 text-xs text-muted-foreground">Loading…</p>
          ) : (
            <div className="flex flex-wrap items-center gap-4 border-t p-3 text-sm">
              <span className="font-medium">Leave type</span>
              {LEAVE_TYPES.map((type) => (
                <span key={type} className="flex items-center gap-1.5">
                  <span className={`size-2.5 rounded-full ${LEAVE_TYPE_STYLE[type].dot}`} aria-hidden />
                  {LEAVE_TYPE_LABEL[type]}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {selected ? (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-medium">
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
              <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                <CalendarDays className="size-4" aria-hidden />
                Nobody is on approved leave on this day.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {selectedLeaves.map((leave) => (
                  <li key={leave.id} className="flex items-center gap-3 rounded-md border p-2">
                    <Avatar size="sm">
                      {leave.employee_photo ? (
                        <AvatarImage src={leave.employee_photo} alt="" />
                      ) : (
                        <AvatarFallback>{initials(leave.employee_name)}</AvatarFallback>
                      )}
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{leave.employee_name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {leave.employee_department} · {leave.start_date} → {leave.end_date}
                      </p>
                    </div>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <span
                        className={`size-2.5 rounded-full ${LEAVE_TYPE_STYLE[leave.leave_type].dot}`}
                        aria-hidden
                      />
                      {LEAVE_TYPE_LABEL[leave.leave_type]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
