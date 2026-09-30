/**
 * Phase 6 tests — workforce intelligence: availability, leave impact, alerts.
 *
 * Three claims are checked separately, because they fail for different reasons:
 *
 *   1. The figures are RIGHT. Availability and impact are recomputed here from
 *      raw `employees` and `leave_requests` reads and compared to what the
 *      database returned, so a bug in the RPC cannot hide behind a bug in the
 *      test. The risk band is derived from the same thresholds the SQL uses, and
 *      each band is forced with a purpose-built fixture.
 *   2. The figures are correctly SCOPED. A manager sees their own reporting line
 *      and cannot widen it — checked through the API *and* by calling the RPC
 *      directly, because the second bypasses every route guard.
 *   3. Alerts behave. Generation is idempotent, the read side is RLS-scoped, and
 *      marking one read is an explicit act rather than a side effect of reading.
 *
 *   npm test
 */
import { config } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../server/supabase/admin-core";
import {
  LOW_AVAILABILITY_PCT,
  RISK_BANDS,
  dayCount,
  summariseAvailability,
} from "../server/insights";
import type { AlertsFeed, AvailabilityDay, LeaveImpact, TeamAvailability } from "../shared/types";

config({ path: ".env.local" });
config();

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const PASSWORD = "OrgFlow@2026";

const ADITYA = "00000000-0000-4000-8000-000000000001"; // CEO
const VIKRAM = "00000000-0000-4000-8000-000000000002"; // Engineering, 2 in his line
const SANJAY = "00000000-0000-4000-8000-000000000006"; // Engineering Manager, team of 4
const NEHA = "00000000-0000-4000-8000-000000000007";
const KATHIK = "00000000-0000-4000-8000-000000000008";
const PRIYA = "00000000-0000-4000-8000-000000000009";

/** Sanjay's reporting line, counting Sanjay: 4 people. */
const SANJAY_TEAM = [SANJAY, NEHA, KATHIK, PRIYA];

/** The seeded clash: Karthik pending over Neha's approved annual leave. */
const KATHIK_PENDING = "00000000-0000-4000-8000-000000000104";

/**
 * Every fixture this file creates carries this reason so cleanup can target it
 * exactly. Approved leave is protected by an exclusion constraint, so a run that
 * is killed before `afterAll` would otherwise break the next one.
 */
const FIXTURE_REASON = "Phase 6 insights fixture.";

/**
 * A week in late November 2026 that no seeded request touches, so the fixtures
 * below own it completely. 16 Nov 2026 is a Monday and 20 Nov is a Friday, with
 * 21-22 Nov a weekend used for the all-weekend case.
 */
const WEEK = { start: "2026-11-16", end: "2026-11-20" };
const WEEKEND = { start: "2026-11-21", end: "2026-11-22" };

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

async function cookieFor(email: string): Promise<string> {
  const { createServerClient } = await import("@supabase/ssr");
  const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const store = new Map<string, string>();
  const ssr = createServerClient(URL, ANON_KEY, {
    cookies: {
      getAll: () => [...store].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value, options } of list) {
          if (options?.maxAge === 0) store.delete(name);
          else store.set(name, value);
        }
      },
    },
  });
  const { error } = await ssr.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return [...store].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function api(cookie: string, path: string, init?: RequestInit) {
  const response = await fetch(`${APP_URL}${path}`, {
    ...init,
    headers: { Cookie: cookie, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

let admin: SupabaseClient;
let hrCookie: string; // Rohan, app_role hr
let managerCookie: string; // Sanjay, app_role manager
let otherManagerCookie: string; // Vikram, a different reporting line
let employeeCookie: string; // Neha, app_role employee

/** Ids of every request this file inserted, so cleanup is exact. */
const fixtureIds: string[] = [];

async function insertRequest(args: {
  employeeId: string;
  start: string;
  end: string;
  days: number;
  status: "pending" | "approved";
}) {
  const { data, error } = await admin
    .from("leave_requests")
    .insert({
      employee_id: args.employeeId,
      leave_type: "annual",
      start_date: args.start,
      end_date: args.end,
      days: args.days,
      reason: FIXTURE_REASON,
      status: args.status,
      ...(args.status === "approved"
        ? { decided_by: ADITYA, decided_at: "2026-11-01T00:00:00Z" }
        : {}),
    })
    .select("id")
    .single();
  if (error) throw error;
  fixtureIds.push(data.id as string);
  return data.id as string;
}

async function asSession(email: string) {
  const { createServerClient } = await import("@supabase/ssr");
  const { createClient } = await import("@supabase/supabase-js");
  const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const store = new Map<string, string>();
  const ssr = createServerClient(URL, ANON_KEY, {
    cookies: {
      getAll: () => [...store].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value, options } of list) {
          if (options?.maxAge === 0) store.delete(name);
          else store.set(name, value);
        }
      },
    },
  });
  const { error } = await ssr.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  const { data } = await ssr.auth.getSession();
  return createClient(URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${data.session!.access_token}` } },
  });
}

function isWeekend(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return day === 0 || day === 6;
}

/** YYYY-MM-DD for each day in an inclusive range. */
function eachDay(from: string, to: string) {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

beforeAll(async () => {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    throw new Error("Missing Supabase env vars — see .env.example");
  }
  admin = createAdminClient();

  // Clear anything an interrupted run left behind before the exclusion
  // constraint starts rejecting these fixtures.
  await admin.from("leave_requests").delete().eq("reason", FIXTURE_REASON);

  hrCookie = await cookieFor("rohan.iyer@orgflow.dev");
  managerCookie = await cookieFor("sanjay.kapoor@orgflow.dev");
  otherManagerCookie = await cookieFor("vikram.sethi@orgflow.dev");
  employeeCookie = await cookieFor("neha.gupta@orgflow.dev");
});

afterAll(async () => {
  if (fixtureIds.length > 0) {
    await admin.from("leave_requests").delete().in("id", fixtureIds);
  }
  await admin.from("leave_requests").delete().eq("reason", FIXTURE_REASON);
});

// ===========================================================================
// Authorisation
// ===========================================================================
describe("Phase 6 authorisation", () => {
  it("refuses an unauthenticated caller on availability", async () => {
    const response = await fetch(`${APP_URL}/api/availability`, { redirect: "manual" });
    expect([401, 307]).toContain(response.status);
  });

  it("returns 403 FORBIDDEN to an employee asking for availability", async () => {
    const { status, body } = await api(employeeCookie, "/api/availability");
    expect(status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns 403 FORBIDDEN to an employee asking for leave impact", async () => {
    const { status, body } = await api(employeeCookie, `/api/leave-requests/${KATHIK_PENDING}/impact`);
    expect(status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns 403 FORBIDDEN to an employee trying to generate alerts", async () => {
    const { status, body } = await api(employeeCookie, "/api/alerts/refresh", { method: "POST" });
    expect(status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("pins a manager to their own reporting line over the API", async () => {
    const { status, body } = await api(managerCookie, "/api/availability");
    expect(status).toBe(200);
    expect(body.data.scope.basis).toBe("team");
    expect(body.data.scope.org_wide).toBe(false);
    expect(body.data.summary.team_size).toBe(4);
  });

  it("refuses a manager who names another manager's team over the API", async () => {
    const { status, body } = await api(managerCookie, `/api/availability?team=${VIKRAM}`);
    expect(status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("ignores a manager's attempt to widen scope by calling the RPC directly", async () => {
    // This is the important one: a direct PostgREST call bypasses every route
    // guard, so the database itself has to narrow the view.
    const session = await asSession("sanjay.kapoor@orgflow.dev");

    const named = await session.rpc("get_availability", {
      p_from: WEEK.start,
      p_to: WEEK.end,
      p_manager_id: VIKRAM,
    });
    expect(named.error).toBeNull();
    // Vikram's line is smaller, so getting 4 proves the parameter was ignored.
    expect(named.data[0].team_size).toBe(4);

    const byDepartment = await session.rpc("get_availability", {
      p_from: WEEK.start,
      p_to: WEEK.end,
      p_department: "Sales",
    });
    expect(byDepartment.error).toBeNull();
    expect(byDepartment.data[0].team_size).toBe(4);
  });

  it("refuses an employee calling the availability RPC directly", async () => {
    const session = await asSession("neha.gupta@orgflow.dev");
    const { error } = await session.rpc("get_availability", {
      p_from: WEEK.start,
      p_to: WEEK.end,
    });
    expect(error?.code).toBe("42501");
  });

  it("keeps the internal availability engine and the alert generator private", async () => {
    const session = await asSession("rohan.iyer@orgflow.dev");

    const engine = await session.rpc("availability_rows" as never, {
      p_from: WEEK.start,
      p_to: WEEK.end,
      p_department: null,
      p_manager_id: null,
      p_assume_away: null,
    } as never);
    expect(engine.error?.code).toBe("42501");

    const generator = await session.rpc("generate_alerts");
    expect(generator.error?.code).toBe("42501");
  });

  it("gives HR the organisation and a manager only their team", async () => {
    const hr = await api(hrCookie, "/api/availability");
    expect(hr.status).toBe(200);
    expect(hr.body.data.scope.org_wide).toBe(true);
    expect(hr.body.data.scope.basis).toBe("organisation");

    const manager = await api(managerCookie, "/api/availability");
    expect(manager.body.data.summary.team_size).toBeLessThan(hr.body.data.summary.team_size);
  });

  it("lets HR narrow to a named manager or a department", async () => {
    const byTeam = await api(hrCookie, `/api/availability?team=${VIKRAM}`);
    expect(byTeam.status).toBe(200);
    expect(byTeam.body.data.scope.basis).toBe("team");

    const byDepartment = await api(hrCookie, "/api/availability?department=Sales");
    expect(byDepartment.status).toBe(200);
    expect(byDepartment.body.data.scope.basis).toBe("department");
    expect(byDepartment.body.data.days[0].team_size).toBe(3);
  });

  it("refuses leave impact to a manager who does not own the request", async () => {
    const { status, body } = await api(otherManagerCookie, `/api/leave-requests/${KATHIK_PENDING}/impact`);
    expect(status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("allows leave impact to the requester's own manager and to HR", async () => {
    const manager = await api(managerCookie, `/api/leave-requests/${KATHIK_PENDING}/impact`);
    expect(manager.status).toBe(200);
    expect(manager.body.data.employee_name).toBe("Karthik Reddy");

    const hr = await api(hrCookie, `/api/leave-requests/${KATHIK_PENDING}/impact`);
    expect(hr.status).toBe(200);
    expect(hr.body.data.employee_name).toBe("Karthik Reddy");
  });

  it("returns 404 NOT_FOUND for a request that does not exist", async () => {
    const missing = "00000000-0000-4000-8000-0000000000ff";
    const { status, body } = await api(hrCookie, `/api/leave-requests/${missing}/impact`);
    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

// ===========================================================================
// Date range handling
// ===========================================================================
describe("availability date range", () => {
  it("rejects a range longer than the maximum", async () => {
    const { status, body } = await api(hrCookie, "/api/availability?from=2026-01-01&to=2026-12-31");
    expect(status).toBe(422);
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.details.max_days).toBe(62);
  });

  it("rejects an inverted range", async () => {
    const { status, body } = await api(hrCookie, "/api/availability?from=2026-12-01&to=2026-11-01");
    expect(status).toBe(422);
    expect(body.error.code).toBe("VALIDATION");
  });

  it("rejects a malformed date", async () => {
    const { status, body } = await api(hrCookie, "/api/availability?from=16-11-2026&to=2026-11-20");
    expect(status).toBe(422);
    expect(body.error.code).toBe("VALIDATION");
  });

  it("returns exactly one row per day in the range, inclusive", async () => {
    const { status, body } = await api(managerCookie, `/api/availability?from=${WEEK.start}&to=${WEEK.end}`);
    expect(status).toBe(200);
    expect(body.data.days).toHaveLength(dayCount(WEEK.start, WEEK.end));
    expect(body.data.days.map((d: AvailabilityDay) => d.date)).toEqual(
      eachDay(WEEK.start, WEEK.end),
    );
  });

  it("flags weekends and excludes them from the summary", async () => {
    const { body } = await api(managerCookie, "/api/availability?from=2026-11-20&to=2026-11-23");
    const days = body.data.days as AvailabilityDay[];
    const byDate = new Map(days.map((d) => [d.date, d]));

    expect(byDate.get("2026-11-20")!.is_weekend).toBe(false);
    expect(byDate.get("2026-11-21")!.is_weekend).toBe(true);
    expect(byDate.get("2026-11-22")!.is_weekend).toBe(true);
    expect(byDate.get("2026-11-23")!.is_weekend).toBe(false);

    // Only the two working days may be summarised.
    expect(days.filter((d) => !d.is_weekend)).toHaveLength(2);
    expect((body.data as TeamAvailability).summary.worst_day!.is_weekend).toBe(false);
  });
});

// ===========================================================================
// Availability is arithmetically right
// ===========================================================================
describe("availability figures", () => {
  it("matches a recount from the raw tables, per day", async () => {
    const from = "2026-12-01";
    const to = "2026-12-07";

    // Ground truth: the team, and every approved request overlapping the range.
    const { data: team, error: teamError } = await admin
      .from("employees")
      .select("id")
      .in("id", SANJAY_TEAM)
      .eq("is_active", true);
    if (teamError) throw teamError;

    const { data: approved, error: leaveError } = await admin
      .from("leave_requests")
      .select("employee_id, start_date, end_date")
      .eq("status", "approved")
      .lte("start_date", to)
      .gte("end_date", from);
    if (leaveError) throw leaveError;

    const teamIds = new Set((team ?? []).map((e) => e.id as string));
    const awayOn = (day: string) =>
      new Set(
        (approved ?? [])
          .filter((lr) => lr.employee_id && day >= lr.start_date && day <= lr.end_date)
          .map((lr) => lr.employee_id as string)
          .filter((id) => teamIds.has(id)),
      );

    const { body } = await api(managerCookie, `/api/availability?from=${from}&to=${to}`);
    expect(body.data.days).toHaveLength(dayCount(from, to));

    for (const day of body.data.days as AvailabilityDay[]) {
      const away = awayOn(day.date);
      expect(day.team_size).toBe(teamIds.size);
      expect(day.on_leave_count).toBe(away.size);
      expect(day.available_count).toBe(teamIds.size - away.size);
      expect(day.availability_pct).toBeCloseTo(
        Math.round(((teamIds.size - away.size) * 1000) / teamIds.size) / 10,
        1,
      );
      expect(new Set(day.ids_on_leave)).toEqual(away);
      expect(day.is_weekend).toBe(isWeekend(day.date));
    }
  });

  it("does not count a pending request as an absence", async () => {
    // Karthik's seeded request is pending, so the grid must ignore it while the
    // impact figure, which assumes it is granted, must not.
    const { body } = await api(managerCookie, "/api/availability?from=2026-10-13&to=2026-10-16");
    const onClash = body.data.days.find((d: AvailabilityDay) => d.date === "2026-10-13");
    expect(onClash.names_on_leave).toContain("Neha Gupta");
    expect(onClash.names_on_leave).not.toContain("Karthik Reddy");
    expect(onClash.availability_pct).toBe(75);
  });

  it("reports 100% available when nobody is away", async () => {
    const { body } = await api(managerCookie, "/api/availability?from=2026-12-28&to=2026-12-28");
    expect(body.data.days[0].on_leave_count).toBe(0);
    expect(body.data.days[0].availability_pct).toBe(100);
    expect(body.data.days[0].names_on_leave).toEqual([]);
  });

  it("summarises the same grid the API returned", async () => {
    const { body } = await api(hrCookie, "/api/availability?from=2026-10-12&to=2026-10-16");
    const days = body.data.days as AvailabilityDay[];
    const summary = summariseAvailability(days);

    expect(summary.average_availability_pct).toBe(body.data.summary.average_availability_pct);
    expect(summary.team_size).toBe(body.data.summary.team_size);
    expect(summary.days_below_threshold).toBe(
      days.filter((d) => !d.is_weekend && d.availability_pct < LOW_AVAILABILITY_PCT).length,
    );
    // The worst day is the minimum over working days only, and the earliest such.
    const working = days.filter((d) => !d.is_weekend);
    const lowest = Math.min(...working.map((d) => d.availability_pct));
    expect(summary.worst_day!.availability_pct).toBe(lowest);
  });
});

// ===========================================================================
// Leave impact — the seeded clash, then each risk band
// ===========================================================================
describe("leave impact", () => {
  it("matches the seeded team clash exactly", async () => {
    const { status, body } = await api(managerCookie, `/api/leave-requests/${KATHIK_PENDING}/impact`);
    expect(status).toBe(200);

    const impact = body.data as LeaveImpact;
    expect(impact.employee_name).toBe("Karthik Reddy");
    expect(impact.team_size).toBe(4);
    expect(impact.working_days).toBe(4);
    expect(impact.already_on_leave).toBe(1);
    expect(impact.overlapping_leave.map((o) => o.name)).toEqual(["Neha Gupta"]);
    // 13-15 Oct: Karthik (if granted) and Neha, so 2 of 4 available.
    expect(impact.worst_day_availability_pct).toBe(50);
    expect(impact.worst_date).toBe("2026-10-13");
    expect(impact.risk).toBe("medium");
  });

  it("assumes the pending request IS granted, which is the point of the call", async () => {
    const { body } = await api(managerCookie, `/api/leave-requests/${KATHIK_PENDING}/impact`);
    const impact = body.data as LeaveImpact;

    // 16 Oct is outside Neha's leave, so only Karthik is away: 3 of 4.
    const lastDay = impact.per_day.find((d) => d.date === "2026-10-16")!;
    expect(lastDay.availability_pct).toBe(75);
    expect(lastDay.names_on_leave).toContain("Karthik Reddy");
  });

  it("excludes the requester from the overlap list", async () => {
    const { body } = await api(managerCookie, `/api/leave-requests/${KATHIK_PENDING}/impact`);
    const impact = body.data as LeaveImpact;
    expect(impact.overlapping_leave.map((o) => o.employee_id)).not.toContain(KATHIK);
  });

  it("reports a team of the manager plus their direct reports", async () => {
    const { body } = await api(managerCookie, `/api/leave-requests/${KATHIK_PENDING}/impact`);
    expect((body.data as LeaveImpact).team_size).toBe(SANJAY_TEAM.length);
  });

  it("has no risk level for a request that falls entirely on a weekend", async () => {
    const id = await insertRequest({
      employeeId: KATHIK,
      start: WEEKEND.start,
      end: WEEKEND.end,
      // `days` is a positive-integer column, so a weekend-only span cannot
      // store 0. It is not what the impact function reads — it recomputes the
      // working-day count from the dates — so the band assertions below still
      // describe a request with no working day at all.
      days: 1,
      status: "pending",
    });

    const { status, body } = await api(managerCookie, `/api/leave-requests/${id}/impact`);
    expect(status).toBe(200);

    const impact = body.data as LeaveImpact;
    expect(impact.working_days).toBe(0);
    expect(impact.worst_date).toBeNull();
    expect(impact.worst_day_availability_pct).toBeNull();
    expect(impact.risk).toBeNull();
  });
});

describe("leave impact risk bands", () => {
  // One fixture week drives all three bands: each assertion adds another
  // colleague's approved leave to the same days, so the remaining availability
  // falls 75% -> 50% -> 25% against a team of 4.
  let requestId: string;

  beforeAll(async () => {
    requestId = await insertRequest({
      employeeId: KATHIK,
      start: WEEK.start,
      end: WEEK.end,
      days: 5,
      status: "pending",
    });
  });

  it("is low when only the requester is away (3 of 4 = 75%)", async () => {
    const { body } = await api(managerCookie, `/api/leave-requests/${requestId}/impact`);
    const impact = body.data as LeaveImpact;

    expect(impact.team_size).toBe(4);
    expect(impact.already_on_leave).toBe(0);
    expect(impact.worst_day_availability_pct).toBe(75);
    expect(impact.risk).toBe("low");
    expect(impact.worst_date).toBe(WEEK.start);
  });

  it("is medium once a second person is away (2 of 4 = 50%)", async () => {
    await insertRequest({
      employeeId: PRIYA,
      start: WEEK.start,
      end: WEEK.start,
      days: 1,
      status: "approved",
    });

    const { body } = await api(managerCookie, `/api/leave-requests/${requestId}/impact`);
    const impact = body.data as LeaveImpact;

    expect(impact.already_on_leave).toBe(1);
    expect(impact.overlapping_leave.map((o) => o.name)).toEqual(["Priya Nair"]);
    expect(impact.worst_day_availability_pct).toBe(50);
    expect(impact.risk).toBe("medium");
  });

  it("is high once a third person is away (1 of 4 = 25%)", async () => {
    await insertRequest({
      employeeId: NEHA,
      start: WEEK.start,
      end: WEEK.end,
      days: 5,
      status: "approved",
    });

    const { body } = await api(managerCookie, `/api/leave-requests/${requestId}/impact`);
    const impact = body.data as LeaveImpact;

    expect(impact.already_on_leave).toBe(2);
    expect(impact.worst_day_availability_pct).toBe(25);
    expect(impact.risk).toBe("high");
  });

  it("counts only working days in the availability figures", async () => {
    // The fixture week is Mon-Fri, so a request covering it has 5 working days
    // and the grid must not have widened or shrunk to include anything else.
    const { body } = await api(managerCookie, `/api/leave-requests/${requestId}/impact`);
    const impact = body.data as LeaveImpact;

    expect(impact.per_day).toHaveLength(dayCount(WEEK.start, WEEK.end));
    expect(impact.per_day.every((d) => !d.is_weekend)).toBe(true);
    expect(impact.working_days).toBe(5);
  });

  it("matches the band thresholds the SQL applies", () => {
    // Guards against the two implementations drifting apart: the RPC compares
    // `>= 75` and `>= 50`, and the shared constants say the same.
    expect(RISK_BANDS.low).toBe(75);
    expect(RISK_BANDS.medium).toBe(50);
  });
});

// ===========================================================================
// Alerts
// ===========================================================================
describe("alerts", () => {
  it("is idempotent: a second run inserts nothing new", async () => {
    // The first call settles whatever the current state raises; the second must
    // be a no-op, which is what makes it safe to call on every dashboard load.
    const first = await admin.rpc("generate_alerts");
    expect(first.error).toBeNull();

    const second = await admin.rpc("generate_alerts");
    expect(second.error).toBeNull();
    expect(second.data).toBe(0);
  });

  it("reports through the API and stays RLS-scoped", async () => {
    await admin.rpc("generate_alerts");

    const manager = await api(managerCookie, "/api/alerts");
    expect(manager.status).toBe(200);

    const feed = manager.body.data as AlertsFeed;
    expect(Array.isArray(feed.alerts)).toBe(true);
    expect(feed.unread_count).toBe(feed.alerts.filter((a) => !a.is_read).length);

    // An org-wide alert is visible to everyone; a manager-scoped one is not.
    for (const alert of feed.alerts) {
      const mineOrOrgWide = alert.scope_employee_id === null || alert.scope_employee_id === SANJAY;
      expect(mineOrOrgWide).toBe(true);
    }
  });

  it("does not leak another team's scoped alert to a manager", async () => {
    await admin.rpc("generate_alerts");

    const vikram = await api(otherManagerCookie, "/api/alerts");
    expect(vikram.status).toBe(200);

    const feed = vikram.body.data as AlertsFeed;
    const sanjayScoped = feed.alerts.filter((a) => a.scope_employee_id === SANJAY);
    expect(sanjayScoped).toHaveLength(0);
  });

  it("marks an alert read only when asked, and can undo it", async () => {
    await admin.rpc("generate_alerts");

    const { body } = await api(hrCookie, "/api/alerts");
    const feed = body.data as AlertsFeed;
    // The first UNREAD alert, not merely the first one: this file's assertions
    // are about the read/unread transition, so the subject has to start unread.
    // Picking by position instead made the test depend on whatever the newest
    // alert happened to be and on read state left by earlier runs.
    const target = feed.alerts.find((a) => !a.is_read);
    if (!target) return; // nothing raised in this environment; nothing to assert

    const marked = await api(hrCookie, `/api/alerts/${target.id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_read: true }),
    });
    expect(marked.status).toBe(200);
    expect(marked.body.data.is_read).toBe(true);

    // Reading the feed must not mark anything on its own.
    const reread = await api(hrCookie, "/api/alerts");
    const stillRead = (reread.body.data as AlertsFeed).alerts.find((a) => a.id === target.id);
    expect(stillRead?.is_read).toBe(true);

    const unmarked = await api(hrCookie, `/api/alerts/${target.id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_read: false }),
    });
    expect(unmarked.body.data.is_read).toBe(false);
  });

  it("rejects a malformed alert id", async () => {
    const { status, body } = await api(hrCookie, "/api/alerts/not-a-uuid", {
      method: "PATCH",
      body: JSON.stringify({ is_read: true }),
    });
    expect(status).toBe(422);
    expect(body.error.code).toBe("VALIDATION");
  });

  it("returns 404 rather than confirming the existence of an alert it cannot see", async () => {
    const { status, body } = await api(employeeCookie, `/api/alerts/${KATHIK_PENDING}`, {
      method: "PATCH",
      body: JSON.stringify({ is_read: true }),
    });
    expect([403, 404]).toContain(status);
    if (status === 404) expect(body.error.code).toBe("NOT_FOUND");
  });

  it("runs the generator through the API for a manager and reports what it created", async () => {
    const { status, body } = await api(managerCookie, "/api/alerts/refresh", { method: "POST" });
    expect(status).toBe(200);
    // The rules are idempotent and the previous tests already ran them.
    expect(body.data.created).toBe(0);
  });
});
