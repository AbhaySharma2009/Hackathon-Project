/**
 * Phase 5 tests — the HR dashboard and its analytics.
 *
 * Two things are being checked, and they are different:
 *
 *   1. That the numbers are RIGHT. Every aggregate is recomputed here as plain
 *      SQL against the same database and compared to what the API returned, so
 *      a bug in the RPC cannot be hidden by a bug in the test.
 *   2. That the numbers are correctly SCOPED. HR gets the organisation, a
 *      manager gets their own team, an employee gets nothing at all — enforced
 *      in Postgres, not just hidden in the UI.
 *
 *   npm test
 */
import { config } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../lib/supabase/admin-core";
import type { DashboardSummary } from "../lib/types";

config({ path: ".env.local" });
config();

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const PASSWORD = "OrgFlow@2026";

const ADITYA = "00000000-0000-4000-8000-000000000001"; // CEO
const SANJAY = "00000000-0000-4000-8000-000000000006"; // Engineering Manager
const NEHA = "00000000-0000-4000-8000-000000000007";
const PRIYA = "00000000-0000-4000-8000-000000000009";
const KATHIK = "00000000-0000-4000-8000-000000000008";
const FATIMA = "00000000-0000-4000-8000-000000000013"; // Sales, reports to Nikhil
const DEEPAK = "00000000-0000-4000-8000-000000000014"; // HR & Operations

/**
 * Every fixture this file creates carries this reason, so cleanup can target it
 * exactly. Approved leave is protected by an exclusion constraint, so a run that
 * is killed before `afterAll` would otherwise break the next run.
 */
const FIXTURE_REASON = "Phase 5 dashboard fixture.";

/** Day ranges are unique per person so no fixture can collide with the seed. */
function days(from: number, span: number) {
  const start = new Date(2026, 0, from);
  const end = new Date(2026, 0, from + span - 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

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

async function api(cookie: string, path = "/api/dashboard/summary") {
  const response = await fetch(`${APP_URL}${path}`, { headers: { Cookie: cookie } });
  return { status: response.status, body: await response.json() };
}

async function insertRequest(
  employeeId: string,
  start: string,
  end: string,
  status: "approved" | "pending" | "rejected",
  days_: number,
  decidedBy?: string,
  leaveType: "casual" | "sick" | "annual" = "casual",
) {
  const { data, error } = await admin
    .from("leave_requests")
    .insert({
      employee_id: employeeId,
      leave_type: leaveType,
      start_date: start,
      end_date: end,
      days: days_,
      reason: FIXTURE_REASON,
      status,
      ...(status === "pending"
        ? {}
        : { decided_by: decidedBy ?? ADITYA, decided_at: "2026-09-01T00:00:00Z" }),
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

let admin: SupabaseClient;
let hrCookie: string; // Rohan, app_role hr
let managerCookie: string; // Sanjay, app_role manager
let employeeCookie: string; // Neha, app_role employee

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
  employeeCookie = await cookieFor("neha.gupta@orgflow.dev");
});

afterAll(async () => {
  await admin.from("leave_requests").delete().eq("reason", FIXTURE_REASON);
});

const summaryFor = async (cookie: string) => (await api(cookie)).body.data as DashboardSummary;

/**
 * Ids of every employee the dashboard counts: the active ones.
 *
 * The ground-truth reads below must use this set rather than all balance rows,
 * because the aggregates deliberately exclude inactive employees — comparing
 * against an unfiltered ledger would fail for the right reason at the wrong time.
 */
async function activeEmployeeIds() {
  const { data, error } = await admin.from("employees").select("id").eq("is_active", true);
  if (error) throw error;
  return (data ?? []).map((e) => e.id);
}

/**
 * Reads the dashboard and an independent recount of the same figures, and only
 * returns them when the database did not change in between.
 *
 * The suite shares one database across parallel test files, so a row can be
 * inserted or removed between the two reads. Asserting against a snapshot that
 * moved would report a false failure, so a changed snapshot is retried; four
 * attempts in a row means something is genuinely unstable and the test should
 * fail loudly.
 */
async function stableSummary<T>(
  cookie: string,
  recount: (ids: string[]) => Promise<T>,
  attempts = 4,
): Promise<{ summary: DashboardSummary; truth: T }> {
  let drift: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const before = JSON.stringify(await recount(await activeEmployeeIds()));
    const summary = await summaryFor(cookie);
    const after = JSON.stringify(await recount(await activeEmployeeIds()));

    if (before === after) return { summary, truth: JSON.parse(after) as T };
    drift = { before, after };
  }

  throw new Error(`database kept changing while reading the dashboard: ${JSON.stringify(drift)}`);
}

// ===========================================================================
// Authorisation — the "FORBIDDEN for non-HR" requirement
// ===========================================================================
describe("GET /api/dashboard/summary authorisation", () => {
  it("refuses an unauthenticated caller", async () => {
    const response = await fetch(`${APP_URL}/api/dashboard/summary`, { redirect: "manual" });
    expect([401, 307]).toContain(response.status);
  });

  it("returns 403 FORBIDDEN to an employee", async () => {
    const { status, body } = await api(employeeCookie);
    expect(status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("gives HR the organisation", async () => {
    const { status, body } = await api(hrCookie);
    expect(status).toBe(200);
    expect(body.data.scope.app_role).toBe("hr");
    expect(body.data.scope.org_wide).toBe(true);
  });

  it("gives a manager only their own team", async () => {
    const summary = await summaryFor(managerCookie);
    expect(summary.scope.app_role).toBe("manager");
    expect(summary.scope.org_wide).toBe(false);

    // Sanjay manages Neha, Karthik and Priya: four people including himself.
    expect(summary.kpis.headcount_total).toBe(4);
    // Every person counted must be him or one of his direct reports — never a
    // colleague in another reporting line.
    const accounted = new Set(
      summary.top_leave_takers.map((t) => t.employee_id).concat(
        summary.recent_activity.map((a) => a.employee_id),
      ),
    );
    for (const id of accounted) {
      expect([SANJAY, NEHA, PRIYA, KATHIK]).toContain(id);
    }
  });

  it("never shows a manager another department's figures", async () => {
    const summary = await summaryFor(managerCookie);
    // Sanjay's team is entirely Engineering.
    const departments = new Set(summary.headcount_by_department.map((d) => d.department));
    expect([...departments]).toEqual(["Engineering"]);
  });

  it("keeps the aggregate helpers unreachable directly", async () => {
    // The helpers take an arbitrary employee-id list, so if a session could call
    // them directly the role check in get_dashboard_summary would be bypassable.
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } },
    );
    await client.auth.signInWithPassword({
      email: "neha.gupta@orgflow.dev",
      password: PASSWORD,
    });

    for (const fn of [
      "dashboard_headcount_by_department",
      "dashboard_department_workforce",
      "dashboard_leave_balances",
      "dashboard_top_leave_takers",
    ]) {
      const { error } = await client.rpc(fn as never, {} as never);
      expect(error, `${fn} should not be callable by a session`).not.toBeNull();
    }
  });
});

// ===========================================================================
// Numbers must match direct SQL counts
// ===========================================================================
describe("GET /api/dashboard/summary figures", () => {
  it("matches direct counts for headcount and pending approvals", async () => {
    const { summary, truth } = await stableSummary(
      hrCookie,
      async () => {
        const [{ count: active }, { count: pending }] = await Promise.all([
          admin.from("employees").select("id", { count: "exact", head: true }).eq("is_active", true),
          admin.from("leave_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
        ]);
        return { active: active ?? 0, pending: pending ?? 0 };
      },
    );

    expect(summary.kpis.headcount_total).toBe(truth.active);
    expect(summary.kpis.pending_approvals).toBe(truth.pending);
  });

  it("matches direct counts per department", async () => {
    const { summary, truth } = await stableSummary(hrCookie, async (ids) => {
      const { data } = await admin
        .from("employees")
        .select("department")
        .eq("is_active", true)
        .in("id", ids);
      const counts = new Map<string, number>();
      for (const e of data ?? []) counts.set(e.department, (counts.get(e.department) ?? 0) + 1);
      return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
    });

    expect(summary.headcount_by_department).toHaveLength(truth.length);
    for (const [department, headcount] of truth) {
      expect(summary.headcount_by_department.find((d) => d.department === department)?.headcount,
        department,
      ).toBe(headcount);
    }
    // The departments must add up to the headcount card, not just match one at a time.
    const summed = summary.headcount_by_department.reduce((n, r) => n + r.headcount, 0);
    expect(summed).toBe(summary.kpis.headcount_total);
  });

  it("matches the balance ledger for allocated, used and remaining", async () => {
    const { summary, truth } = await stableSummary(hrCookie, async (ids) => {
      const year = new Date().getFullYear();
      const { data } = await admin
        .from("leave_balances")
        .select("leave_type, allocated, used, remaining")
        .eq("year", year)
        .in("employee_id", ids);

      const totals = new Map<string, { allocated: number; used: number; remaining: number }>();
      for (const row of data ?? []) {
        const key = row.leave_type as string;
        const acc = totals.get(key) ?? { allocated: 0, used: 0, remaining: 0 };
        acc.allocated += Number(row.allocated);
        acc.used += Number(row.used);
        acc.remaining += Number(row.remaining);
        totals.set(key, acc);
      }
      return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
    });

    for (const [type, expected] of truth) {
      const bucket = summary.leave_balance_by_type.find((b) => b.leave_type === type);
      expect(bucket, `missing ${type}`).toBeDefined();
      expect(Number(bucket!.allocated), `${type} allocated`).toBeCloseTo(expected.allocated, 5);
      expect(Number(bucket!.used), `${type} used`).toBeCloseTo(expected.used, 5);
      // `remaining` is a generated column, so this also proves the aggregate is
      // not drifting from the ledger it claims to summarise.
      expect(Number(bucket!.remaining), `${type} remaining`).toBeCloseTo(expected.remaining, 5);
    }
  });

  it("keeps per-department balances adding up to the org-wide totals", async () => {
    const summary = await summaryFor(hrCookie);

    for (const type of ["casual", "sick", "annual"] as const) {
      const total = summary.leave_balance_by_type.find((b) => b.leave_type === type);
      const parts = summary.leave_balance_by_department.filter(
        (b) => b.leave_type === type,
      );
      const sum = parts.reduce((n, p) => n + Number(p.used), 0);
      expect(sum, `${type} per-department used should total the org figure`).toBe(
        Number(total!.used),
      );
    }
  });

  it("reports availability that is consistent with its own headcount", async () => {
    const summary = await summaryFor(hrCookie);
    expect(summary.department_workforce.length).toBeGreaterThan(0);

    for (const row of summary.department_workforce) {
      expect(row.available_today, row.department).toBe(row.headcount - row.on_leave_today);
      const expected =
        row.headcount === 0
          ? 100
          : Math.round(((row.headcount - row.on_leave_today) * 1000) / row.headcount) / 10;
      expect(Number(row.availability_pct), row.department).toBe(expected);
    }
  });

  it("limits the activity feed to the last 10 events, newest first", async () => {
    const summary = await summaryFor(hrCookie);
    expect(summary.recent_activity.length).toBeLessThanOrEqual(10);

    const stamps = summary.recent_activity.map((a) => new Date(a.occurred_at).getTime());
    const sorted = [...stamps].sort((a, b) => b - a);
    expect(stamps).toEqual(sorted);

    // Cancelled requests are not leave activity worth reporting.
    for (const item of summary.recent_activity) {
      expect(item.status).not.toBe("cancelled");
    }
  });

  it("names the current quarter for the top-leave-takers card", async () => {
    const summary = await summaryFor(hrCookie);
    const now = new Date();
    expect(summary.quarter.label).toBe(
      `${now.getFullYear()} Q${Math.floor(now.getMonth() / 3) + 1}`,
    );
  });
});

// ===========================================================================
// The numbers must move when the data moves
// ===========================================================================
describe("GET /api/dashboard/summary reacts to changes", () => {
  it("counts an employee as soon as they join", async () => {
    const before = await summaryFor(hrCookie);

    const { data, error } = await admin
      .from("employees")
      .insert({
        name: "Test Hire",
        email: "test.hire@orgflow.dev",
        role: "QA Engineer",
        app_role: "employee",
        department: "Engineering",
        manager_id: SANJAY,
        join_date: "2026-09-01",
        is_active: true,
      })
      .select("id")
      .single();
    if (error) throw error;

    try {
      const after = await summaryFor(hrCookie);
      expect(after.kpis.headcount_total).toBe(before.kpis.headcount_total + 1);

      const engineering = after.headcount_by_department.find((d) => d.department === "Engineering");
      expect(engineering?.headcount).toBe(
        (before.headcount_by_department.find((d) => d.department === "Engineering")?.headcount ??
          0) + 1,
      );
    } finally {
      await admin.from("employees").delete().eq("id", data.id);
    }

    // And the removal is reflected too, so the card is not a one-way ratchet.
    const restored = await summaryFor(hrCookie);
    expect(restored.kpis.headcount_total).toBe(before.kpis.headcount_total);
  });

  it("moves the pending count when a request is approved", async () => {
    const range = days(12, 3);
    const id = await insertRequest(NEHA, range.start, range.end, "pending", 3);

    const before = await summaryFor(hrCookie);
    expect(before.kpis.pending_approvals).toBeGreaterThan(0);

    // Approve through the real RPC so the balance and the request move together.
    const { createClient } = await import("@supabase/supabase-js");
    const manager = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } },
    );
    await manager.auth.signInWithPassword({
      email: "sanjay.kapoor@orgflow.dev",
      password: PASSWORD,
    });

    // The fixture is casual leave, so casual is the balance that must move.
    const beforeUsed = await used(NEHA, "casual");

    try {
      const { data: verdict, error } = await manager.rpc("approve_leave_request", {
        p_request_id: id,
        p_comment: "Phase 5 live-update check.",
      });
      expect(error).toBeNull();
      expect((verdict as { ok: boolean }).ok).toBe(true);

      const after = await summaryFor(hrCookie);
      expect(after.kpis.pending_approvals).toBe(before.kpis.pending_approvals - 1);

      // The approval also spent casual balance, so the balance card must move too.
      const casualAfter = after.leave_balance_by_type.find((b) => b.leave_type === "casual");
      const casualBefore = before.leave_balance_by_type.find((b) => b.leave_type === "casual");
      expect(Number(casualAfter!.used)).toBe(Number(casualBefore!.used) + 3);
      expect(await used(NEHA, "casual")).toBe(beforeUsed + 3);
    } finally {
      // Approving permanently spends the balance, so it is restored here.
      // Without this the ledger drifts by 3 days on every run and later
      // assertions start passing or failing for the wrong reason.
      await admin
        .from("leave_balances")
        .update({ used: beforeUsed })
        .eq("employee_id", NEHA)
        .eq("year", new Date().getFullYear())
        .eq("leave_type", "casual");
    }
  });

  it("counts a new pending request immediately", async () => {
    const range = days(20, 2);
    await insertRequest(NEHA, range.start, range.end, "pending", 2);

    const summary = await summaryFor(hrCookie);
    const feed = summary.recent_activity.find((r) => r.employee_id === NEHA);
    expect(feed?.event).toBe("submitted");
  });

  it("shows a request that covers today as someone out today", async () => {
    const today = new Date();
    const iso = today.toISOString().slice(0, 10);

    // Only meaningful if the RPC is looking at the same "today" the test is.
    await insertRequest(FATIMA, iso, iso, "approved", 1);

    const summary = await summaryFor(hrCookie);
    const sales = summary.department_workforce.find((d) => d.department === "Sales");
    expect(sales?.on_leave_today).toBe(1);
    expect(summary.kpis.on_leave_today).toBeGreaterThanOrEqual(1);
  });

  it("excludes a rejected request from the quarter totals", async () => {
    // Placed inside the current quarter so it would be summed if it counted.
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 10);
    const end = new Date(now.getFullYear(), now.getMonth(), 13);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    const before = await summaryFor(hrCookie);
    const beforeTotal = before.top_leave_takers.reduce((n, t) => n + Number(t.days), 0);
    const beforeUsed = before.leave_balance_by_type
      .filter((b) => b.leave_type !== "unpaid")
      .reduce((n, b) => n + Number(b.used), 0);

    await insertRequest(NEHA, iso(start), iso(end), "rejected", 4);

    const after = await summaryFor(hrCookie);
    // Rejected leave is not leave anyone took, so neither total may move — even
    // though the feed and the row itself both exist.
    expect(after.top_leave_takers.reduce((n, t) => n + Number(t.days), 0)).toBe(beforeTotal);
    expect(
      after.leave_balance_by_type
        .filter((b) => b.leave_type !== "unpaid")
        .reduce((n, b) => n + Number(b.used), 0),
    ).toBe(beforeUsed);
  });
});

describe("department workforce detail", () => {
  it("reports pending requests per department", async () => {
    const range = days(28, 2);
    await insertRequest(DEEPAK, range.start, range.end, "pending", 2);

    const summary = await summaryFor(hrCookie);
    const hrDept = summary.department_workforce.find((d) => d.department === "HR & Operations");
    expect(hrDept?.pending_requests).toBeGreaterThanOrEqual(1);
  });
});

/** Days spent against one leave type, used to check that an approval debits it. */
async function used(employeeId: string, leaveType: string) {
  const { data, error } = await admin
    .from("leave_balances")
    .select("used")
    .eq("employee_id", employeeId)
    .eq("year", new Date().getFullYear())
    .eq("leave_type", leaveType)
    .single();
  if (error) throw error;
  return Number(data?.used ?? 0);
}
