/**
 * Shared workforce-intelligence vocabulary.
 *
 * Isomorphic on purpose — the API routes, the client components and the tests all
 * read the same thresholds, so a "low availability" day is defined in exactly one
 * place. It stays free of `server-only` and `next/server` imports.
 *
 * Rule 1 still applies: Postgres owns the availability numbers and the risk
 * level. What lives here is only the *shape* of a request, the range limits that
 * protect the query, and the roll-up of a grid the database already produced.
 */
import { z } from "zod";
import type { AvailabilityDay, TeamAvailability } from "@/shared/types";

/** ISO calendar date, `YYYY-MM-DD` — the same form the RPCs take. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.");

/**
 * A long range would ask Postgres to expand one row per person per day, so the
 * window is bounded. 62 days covers a two-month view plus navigation slack.
 */
export const MAX_RANGE_DAYS = 62;
export const DEFAULT_RANGE_DAYS = 41;

/** Below this the grid is drawn as a gap rather than the neutral fill. */
export const LOW_AVAILABILITY_PCT = 60;

/** Risk bands, as implemented by `get_leave_impact`. Kept here to label them. */
export const RISK_BANDS = { low: 75, medium: 50 } as const;
export type RiskLevel = "low" | "medium" | "high";

/** Query for the availability grid: a date window plus at most one filter. */
export const availabilityQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    department: z.string().trim().max(80).optional(),
    /** A manager's employee id. Only HR may name someone other than themselves. */
    team: z.string().uuid("Use a manager's employee id for the team filter.").optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: "The start date must be on or before the end date.",
    path: ["from"],
  });

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

/** Resolves a partial query into the window the RPC will actually be given. */
export function resolveRange(query: {
  from?: string;
  to?: string;
}): { from: string; to: string } {
  const from = query.from ?? new Date().toISOString().slice(0, 10);
  // Omitting `to` is what the RPC's own default does; both sides agree.
  const to =
    query.to ??
    new Date(new Date(`${from}T00:00:00Z`).getTime() + (DEFAULT_RANGE_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);

  return { from, to };
}

export function dayCount(from: string, to: string): number {
  const span = new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime();
  return Math.round(span / 86_400_000) + 1;
}

/**
 * Rolls a day grid up into the few figures the page headline needs.
 *
 * The arithmetic is a sum and a mean over values the database computed — it
 * derives nothing the RPC did not already decide. Only working days count:
 * a weekend at 60% is not a coverage problem, and averaging them in would
 * flatter every team.
 */
export function summariseAvailability(days: AvailabilityDay[]) {
  const working = days.filter((day) => !day.is_weekend);

  // First day at the lowest availability, so the caption names the earliest gap.
  const worst = working.reduce<AvailabilityDay | null>((lowest, day) => {
    if (!lowest || day.availability_pct < lowest.availability_pct) return day;
    return lowest;
  }, null);

  const average = working.length
    ? Math.round(
        (working.reduce((sum, day) => sum + day.availability_pct, 0) / working.length) * 10,
      ) / 10
    : 100;

  return {
    // Headcount is constant across a range, but read it rather than assume it.
    team_size: days[0]?.team_size ?? 0,
    worst_day: worst,
    average_availability_pct: average,
    days_below_threshold: working.filter((day) => day.availability_pct < LOW_AVAILABILITY_PCT)
      .length,
  };
}

export type AvailabilitySummary = ReturnType<typeof summariseAvailability>;

/** Tones for a day's fill, shared by the grid and the legend. */
export function availabilityTone(pct: number): "full" | "low" | "critical" {
  if (pct < 40) return "critical";
  if (pct < LOW_AVAILABILITY_PCT) return "low";
  return "full";
}

export const RISK_LABEL: Record<RiskLevel, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

/**
 * Risk styling uses the app's semantic tokens rather than fixed emerald/amber/red,
 * so it follows the light and dark palettes and stays consistent with the
 * availability heatmap and the status badges. The risk is always accompanied by
 * a word (`RISK_LABEL`) and an icon, never by colour alone.
 */
export const RISK_CLASS: Record<RiskLevel, string> = {
  low: "border-success/40 bg-success/10 text-success-foreground",
  medium: "border-warning/50 bg-warning/12 text-warning-foreground",
  high: "border-destructive/45 bg-destructive/10 text-destructive",
};

/** One-line summary of an impact, for the dialog and for tests to assert on. */
export function describeImpact(impact: {
  risk: RiskLevel | null;
  worst_day_availability_pct: number | null;
  worst_date: string | null;
  already_on_leave: number;
}): string {
  if (impact.risk === null) {
    return "This request falls entirely on a weekend, so it costs no working-day coverage.";
  }
  if (impact.already_on_leave === 0) {
    return "Nobody else in this reporting line is away on those dates.";
  }
  return `${impact.already_on_leave} other ${impact.already_on_leave === 1 ? "person is" : "people are"} already away — worst day ${impact.worst_date} at ${impact.worst_day_availability_pct}% available.`;
}

/** Assembles the API payload from an RPC result, keeping the shape in one place. */
export function buildAvailabilityResponse(args: {
  days: AvailabilityDay[];
  scope: TeamAvailability["scope"];
  from: string;
  to: string;
}): TeamAvailability {
  return {
    scope: args.scope,
    from: args.from,
    to: args.to,
    generated_at: new Date().toISOString(),
    days: args.days,
    summary: summariseAvailability(args.days),
  };
}
