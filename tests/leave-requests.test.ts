/**
 * Leave request rule tests — the business rules live in Postgres, so these call
 * the RPCs and the HTTP API directly, with no UI in the loop.
 *
 *   npm test
 *
 * Every case runs as Neha Gupta (role: employee) through a real session, so the
 * RPCs resolve her from auth.uid(). Rows created during the run are removed in
 * afterAll; the one deliberate exception is a balance override, which is
 * restored there too.
 */
import { config } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../lib/supabase/admin-core";

config({ path: ".env.local" });
config();

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const PASSWORD = "OrgFlow@2026";

const NEHA = "00000000-0000-4000-8000-000000000007";
const FATIMA = "00000000-0000-4000-8000-000000000013";

/** Rows this file creates, removed in afterAll. */
const created = new Set<string>();

/**
 * The seeded request ids, which are stable and must survive. Anything else
 * belonging to Neha was written by a previous run of this file.
 *
 * `afterAll` removes what it created, but a run that is killed part-way through
 * never reaches it — and the leftover rows then make a later run fail with a
 * spurious OVERLAP, because the test asks for dates that are no longer free.
 * Clearing them on the way in makes the file safe to re-run.
 */
const SEEDED_REQUEST_IDS = [
  "00000000-0000-4000-8000-000000000101",
  "00000000-0000-4000-8000-000000000102",
  "00000000-0000-4000-8000-000000000103",
  "00000000-0000-4000-8000-000000000104",
  "00000000-0000-4000-8000-000000000105",
  "00000000-0000-4000-8000-000000000106",
] as const;

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

/** Calls an OrgFlow route handler with a real session cookie. */
async function api(
  cookie: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const response = await fetch(`${APP_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Cookie: cookie,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

let employee: SupabaseClient;
let cookie: string;
let admin: SupabaseClient;

beforeAll(async () => {
  if (!URL || !ANON_KEY) throw new Error("Missing Supabase env vars — see .env.example");
  employee = await signIn("neha.gupta@orgflow.dev");
  admin = createAdminClient();

  // The HTTP tests need the exact cookie the app reads, so sign in through
  // @supabase/ssr and keep whatever it writes.
  const { createServerClient } = await import("@supabase/ssr");
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
  const { error: signInError } = await ssr.auth.signInWithPassword({
    email: "neha.gupta@orgflow.dev",
    password: PASSWORD,
  });
  if (signInError) throw signInError;
  cookie = [...store].map(([name, value]) => `${name}=${value}`).join("; ");

  // Drop anything a previously interrupted run left behind, so the overlap and
  // balance assertions below start from the seeded state.
  await admin
    .from("leave_requests")
    .delete()
    .eq("employee_id", NEHA)
    .not("id", "in", `(${SEEDED_REQUEST_IDS.join(",")})`);
});

afterAll(async () => {
  for (const id of created) {
    await admin.from("leave_requests").delete().eq("id", id);
  }
  // Restore Neha's annual balance to the seeded 4 used / 16 remaining.
  await admin
    .from("leave_balances")
    .update({ allocated: 20, used: 4 })
    .eq("employee_id", NEHA)
    .eq("year", new Date().getFullYear())
    .eq("leave_type", "annual");
});

const validate = (leave_type: string, start_date: string, end_date: string) =>
  employee.rpc("validate_leave_request", {
    p_leave_type: leave_type as never,
    p_start: start_date,
    p_end: end_date,
  });

describe("validate_leave_request", () => {
  it("accepts a valid range and reports the duration and balance", async () => {
    const { data, error } = await validate("annual", "2026-11-09", "2026-11-10");
    expect(error).toBeNull();

    const result = data as Record<string, unknown>;
    expect(result.valid).toBe(true);
    expect(result.days).toBe(2); // Monday + Tuesday
    expect(result.available_balance).toBe(16);
    expect(result.error_code).toBeNull();
    expect(result.conflicts).toEqual([]);
  });

  it("rejects an overlap with an APPROVED request and names the range", async () => {
    const { data } = await validate("annual", "2026-10-12", "2026-10-14");
    const result = data as Record<string, unknown>;

    expect(result.valid).toBe(false);
    expect(result.error_code).toBe("OVERLAP");
    expect(result.error_message).toBe(
      "You already have approved leave from 10 Oct to 15 Oct that overlaps with these dates.",
    );
    expect((result.conflicts as unknown[]).length).toBe(1);
  });

  it("rejects an overlap with a PENDING request too", async () => {
    // Give Neha a pending request, then try to overlap it.
    const { data: createdRow, error } = await employee.rpc("create_leave_request", {
      p_leave_type: "casual" as never,
      p_start: "2026-12-07",
      p_end: "2026-12-09",
      p_reason: "Sister's wedding, travel booked.",
    });
    expect(error).toBeNull();
    const id = (createdRow as { id: string }).id;
    created.add(id);

    const { data } = await validate("annual", "2026-12-09", "2026-12-11");
    const result = data as Record<string, unknown>;

    expect(result.valid).toBe(false);
    expect(result.error_code).toBe("OVERLAP");
    expect(result.error_message).toContain("pending leave from 07 Dec to 09 Dec");
  });

  it("rejects a request larger than the remaining balance", async () => {
    const { data } = await validate("annual", "2026-10-19", "2026-11-20");
    const result = data as Record<string, unknown>;

    expect(result.valid).toBe(false);
    expect(result.error_code).toBe("INSUFFICIENT_BALANCE");
    expect(result.days).toBe(25);
    expect(result.available_balance).toBe(16);
    expect(result.error_message).toBe(
      "Insufficient leave balance. Available: 16 days, Requested: 25 days.",
    );
  });

  it("rejects the seeded 25-day request against a 22-day balance", async () => {
    // The balance lives on the caller's row, so the same rule is reproduced on
    // Neha's ledger: set her annual remaining to exactly 22, then ask for 25.
    const { data: before } = await admin
      .from("leave_balances")
      .select("used")
      .eq("employee_id", NEHA)
      .eq("year", 2026)
      .eq("leave_type", "annual")
      .single();
    expect(before).not.toBeNull();

    await admin
      .from("leave_balances")
      .update({ allocated: 27, used: 5 })
      .eq("employee_id", NEHA)
      .eq("year", 2026)
      .eq("leave_type", "annual");

    const { data } = await validate("annual", "2026-10-19", "2026-11-20");
    const result = data as Record<string, unknown>;

    expect(result.error_code).toBe("INSUFFICIENT_BALANCE");
    expect(result.available_balance).toBe(22);
    expect(result.error_message).toContain("Available: 22 days, Requested: 25 days.");
  });

  it("rejects an end date before the start date", async () => {
    const { data } = await validate("casual", "2026-11-20", "2026-11-10");
    const result = data as Record<string, unknown>;

    expect(result.valid).toBe(false);
    expect(result.error_code).toBe("INVALID_DATES");
    expect(result.error_message).toBe(
      "The end date must be on or after the start date.",
    );
  });

  it("rejects a start date in the past", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const { data } = await validate("casual", yesterday, yesterday);
    const result = data as Record<string, unknown>;

    expect(result.valid).toBe(false);
    expect(result.error_code).toBe("INVALID_DATES");
    expect(result.error_message).toContain("cannot start in the past");
  });

  it("rejects a weekend with no working days", async () => {
    const { data } = await validate("casual", "2026-11-14", "2026-11-15"); // Sat + Sun
    const result = data as Record<string, unknown>;

    expect(result.valid).toBe(false);
    expect(result.error_code).toBe("INVALID_DATES");
    expect(result.days).toBe(0);
  });

  it("rejects a range that crosses a calendar year", async () => {
    const { data } = await validate("casual", "2026-12-28", "2027-01-04");
    const result = data as Record<string, unknown>;

    expect(result.error_code).toBe("INVALID_DATES");
    expect(result.error_message).toContain("cannot span more than one calendar year");
  });

  it("does not cap unpaid leave", async () => {
    const { data } = await validate("unpaid", "2026-11-23", "2026-11-30");
    const result = data as Record<string, unknown>;

    expect(result.valid).toBe(true);
    expect(result.available_balance).toBeNull();
  });
});

describe("create_leave_request", () => {
  it("creates a pending request and leaves the balance untouched", async () => {
    const { data: balancesBefore } = await employee
      .from("leave_balances")
      .select("leave_type, used, remaining")
      .eq("leave_type", "sick");
    expect(balancesBefore).not.toBeNull();

    const { data, error } = await employee.rpc("create_leave_request", {
      p_leave_type: "sick" as never,
      p_start: "2026-11-09",
      p_end: "2026-11-10",
      p_reason: "Dental appointment and recovery.",
    });
    expect(error).toBeNull();

    const result = data as Record<string, unknown>;
    expect(result.valid).toBe(true);
    expect(result.days).toBe(2);
    created.add(result.id as string);

    const { data: row } = await employee
      .from("leave_requests")
      .select("id, employee_id, status, days, decided_by")
      .eq("id", result.id as string)
      .single();

    expect(row?.employee_id).toBe(NEHA);
    expect(row?.status).toBe("pending");
    expect(Number(row?.days)).toBe(2);
    expect(row?.decided_by).toBeNull();

    // The whole point of this phase: creating a request must not spend days.
    const { data: balancesAfter } = await employee
      .from("leave_balances")
      .select("leave_type, used, remaining")
      .eq("leave_type", "sick");
    expect(balancesAfter).toEqual(balancesBefore);
  });

  it("re-validates inside the transaction instead of trusting a dry run", async () => {
    // A dry run says this is fine…
    const { data: dryRun } = await validate("casual", "2026-11-25", "2026-11-27");
    expect((dryRun as Record<string, unknown>).valid).toBe(true);

    // …then the same call also creates a pending request that blocks it.
    const { data: first } = await employee.rpc("create_leave_request", {
      p_leave_type: "casual" as never,
      p_start: "2026-11-25",
      p_end: "2026-11-27",
      p_reason: "Errand that needs a weekday off.",
    });
    created.add((first as { id: string }).id);

    // …so the second one is rejected even though the earlier verdict said ok.
    const { data: second } = await employee.rpc("create_leave_request", {
      p_leave_type: "annual" as never,
      p_start: "2026-11-25",
      p_end: "2026-11-27",
      p_reason: "Trying to book the same days twice.",
    });
    const result = second as Record<string, unknown>;

    expect(result.valid).toBe(false);
    expect(result.error_code).toBe("OVERLAP");
  });

  it("rejects a reason outside 5–500 characters", async () => {
    const { data } = await employee.rpc("create_leave_request", {
      p_leave_type: "casual" as never,
      p_start: "2026-11-17",
      p_end: "2026-11-18",
      p_reason: "no",
    });
    expect((data as Record<string, unknown>).error_code).toBe("VALIDATION");
  });
});

/** The HTTP suite needs the app running; the RPC suite does not. */
const serverUp = await fetch(APP_URL, { redirect: "manual" })
  .then(() => true)
  .catch(() => false);

if (!serverUp) {
  console.warn(
    `\n[tests] ${APP_URL} is not reachable — skipping the HTTP API suite.\n` +
      `        Run "npm run dev" in another terminal to include it.\n`,
  );
}

describe.skipIf(!serverUp)("HTTP API", () => {
  it("POST /api/leave-requests/validate returns the database verdict", async () => {
    const { status, body } = await api(cookie, "/api/leave-requests/validate", {
      method: "POST",
      body: {
        leave_type: "annual",
        start_date: "2026-10-12",
        end_date: "2026-10-14",
        reason: "overlap check through the API",
      },
    });

    expect(status).toBe(200);
    expect(body.data.error_code).toBe("OVERLAP");
  });

  it("POST /api/leave-requests maps a failed validation onto the error shape", async () => {
    // A short, conflict-free week with a deliberately small balance. The longer
    // 25-day ranges used by the RPC suite would hit the pending rows those tests
    // create, and the overlap check runs before the balance check.
    await admin
      .from("leave_balances")
      .update({ allocated: 20, used: 17 })
      .eq("employee_id", NEHA)
      .eq("year", 2026)
      .eq("leave_type", "annual");

    const { status, body } = await api(cookie, "/api/leave-requests", {
      method: "POST",
      body: {
        leave_type: "annual",
        start_date: "2026-11-30",
        end_date: "2026-12-04",
        reason: "far too long for the balance",
      },
    });

    expect(status).toBe(409);
    expect(body.error.code).toBe("INSUFFICIENT_BALANCE");
    expect(body.error.message).toContain("Requested: 5 days");
  });

  it("POST /api/leave-requests rejects a malformed body with VALIDATION", async () => {
    const { status, body } = await api(cookie, "/api/leave-requests", {
      method: "POST",
      body: { leave_type: "vacation", start_date: "20-11-2026", end_date: "2026-11-20", reason: "x" },
    });

    expect(status).toBe(422);
    expect(body.error.code).toBe("VALIDATION");
  });

  it("POST /api/leave-requests creates a valid request (201)", async () => {
    const { status, body } = await api(cookie, "/api/leave-requests", {
      method: "POST",
      body: {
        leave_type: "casual",
        start_date: "2026-11-23",
        end_date: "2026-11-24",
        reason: "Two days for a family visit.",
      },
    });

    expect(status).toBe(201);
    expect(body.data.valid).toBe(true);
    expect(Number(body.data.days)).toBe(2);
    created.add(body.data.id as string);
  });

  it("GET /api/leave-requests only returns the caller's own rows", async () => {
    const { status, body } = await api(cookie, "/api/leave-requests");
    expect(status).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);
    expect(new Set(body.data.map((r: { employee_id: string }) => r.employee_id))).toEqual(
      new Set([NEHA]),
    );
  });

  it("GET /api/leave-requests for another employee is FORBIDDEN", async () => {
    const { status, body } = await api(cookie, `/api/leave-requests?employee_id=${FATIMA}`);
    expect(status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("GET /api/leave-requests?status= filters", async () => {
    const { body } = await api(cookie, "/api/leave-requests?status=approved");
    expect(body.data.every((r: { status: string }) => r.status === "approved")).toBe(true);
  });

  it("GET /api/leave-balances/[id] reads the caller's own ledger", async () => {
    const { status, body } = await api(cookie, `/api/leave-balances/${NEHA}`);
    expect(status).toBe(200);
    expect(body.data).toHaveLength(4);
  });

  it("GET /api/leave-balances/[id] for someone else is FORBIDDEN", async () => {
    const { status, body } = await api(cookie, `/api/leave-balances/${FATIMA}`);
    expect(status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("requires a session", async () => {
    const response = await fetch(`${APP_URL}/api/leave-requests`, {
      redirect: "manual",
    });
    expect([307, 302, 401, 403]).toContain(response.status);
  });
});
