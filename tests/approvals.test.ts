/**
 * Approval workflow tests — the happy path and the guardrails.
 *
 * The business logic lives in the two decision RPCs (`approve_leave_request`,
 * `reject_leave_request`). These tests call the RPCs directly (via the employee
 * and manager clients) and also hit the HTTP routes so the whole stack is
 * exercised, including the authorisation that the RPCs enforce.
 *
 *   npm test
 *
 * Subject employee: Priya Nair (009), direct manager: Sanjay Kapoor (006).
 * Priya is chosen because the Phase 2 suite only touches Neha, so balances and
 * requests are cleanly isolated. Each test creates its own fixture rows and
 * removes them in afterAll.
 */
import { config } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../lib/supabase/admin-core";

config({ path: ".env.local" });
config();

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const PASSWORD = "OrgFlow@2026";

const PRIYA = "00000000-0000-4000-8000-000000000009"; // employee, reports to Sanjay
const SANJAY = "00000000-0000-4000-8000-000000000006"; // manager of Priya
const NEHA = "00000000-0000-4000-8000-000000000007"; // employee, reports to Sanjay
const ROHAN = "00000000-0000-4000-8000-000000000015"; // HR

/** Rows this file creates, removed in afterAll. */
const createdRequests = new Set<string>();

/** Stable seeded request ids, which must survive the cleanup in `beforeAll`. */
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

async function insertPendingRequest(
  admin: SupabaseClient,
  employeeId: string,
  leaveType: string,
  start: string,
  end: string,
  days: number,
  reason: string,
): Promise<string> {
  const { data, error } = await admin
    .from("leave_requests")
    .insert({
      employee_id: employeeId,
      leave_type: leaveType,
      start_date: start,
      end_date: end,
      days,
      reason,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) throw error;
  createdRequests.add(data.id);
  return data.id;
}

async function getAnnualUsed(admin: SupabaseClient, employeeId: string): Promise<number> {
  const { data, error } = await admin
    .from("leave_balances")
    .select("used")
    .eq("employee_id", employeeId)
    .eq("year", new Date().getFullYear())
    .eq("leave_type", "annual")
    .single();
  if (error) throw error;
  return Number(data?.used ?? 0);
}

let employeeClient: SupabaseClient; // Neha
let managerClient: SupabaseClient; // Sanjay
let skipLevelClient: SupabaseClient; // Vikram
let hrClient: SupabaseClient; // Rohan
let admin: SupabaseClient;

beforeAll(async () => {
  if (!URL || !ANON_KEY) throw new Error("Missing Supabase env vars — see .env.example");
  employeeClient = await signIn("neha.gupta@orgflow.dev");
  managerClient = await signIn("sanjay.kapoor@orgflow.dev");
  skipLevelClient = await signIn("vikram.sethi@orgflow.dev");
  hrClient = await signIn("rohan.iyer@orgflow.dev");
  admin = createAdminClient();

  // A run killed before `afterAll` leaves approved fixtures behind, and because
  // approving spends a balance (rule 2) those leftovers change the starting
  // numbers for the next run. Clearing them here makes the file re-runnable.
  await admin
    .from("leave_requests")
    .delete()
    .eq("employee_id", PRIYA)
    .not("id", "in", `(${SEEDED_REQUEST_IDS.join(",")})`);
});

afterAll(async () => {
  for (const id of createdRequests) {
    await admin.from("leave_requests").delete().eq("id", id);
  }
  // Approving spends a balance for good (rule 2), so deleting the request rows
  // is not enough to undo this file. Leaving the spend in place would drift the
  // ledger by a few days on every run until `used <= allocated` starts rejecting
  // the inserts, so Priya's annual balance is put back to its seeded 20/0.
  await admin
    .from("leave_balances")
    .update({ allocated: 20, used: 0 })
    .eq("employee_id", PRIYA)
    .eq("year", new Date().getFullYear())
    .eq("leave_type", "annual");
});

describe("approve_leave_request", () => {
  it("moves the balance exactly once and records the decider", async () => {
    const id = await insertPendingRequest(
      admin,
      PRIYA,
      "annual",
      "2026-11-16",
      "2026-11-18",
      3,
      "Team offsite in Mysuru.",
    );

    const before = await getAnnualUsed(admin, PRIYA);

    const { data, error } = await managerClient.rpc("approve_leave_request", {
      p_request_id: id,
      p_comment: "Approved. Coverage arranged.",
    });
    expect(error).toBeNull();

    const result = data as { ok: boolean; request: { status: string; decided_by: string } };
    expect(result.ok).toBe(true);
    expect(result.request.status).toBe("approved");
    expect(result.request.decided_by).toBe(SANJAY);

    const after = await getAnnualUsed(admin, PRIYA);
    expect(after).toBe(before + 3);
  });

  it("two concurrent approve calls result in exactly one success", async () => {
    const id = await insertPendingRequest(
      admin,
      PRIYA,
      "annual",
      "2026-11-23",
      "2026-11-25",
      3,
      "Concurrent approve test.",
    );

    const before = await getAnnualUsed(admin, PRIYA);

    const [r1, r2] = await Promise.all([
      managerClient.rpc("approve_leave_request", { p_request_id: id, p_comment: "first" }),
      managerClient.rpc("approve_leave_request", { p_request_id: id, p_comment: "second" }),
    ]);

    const okCount = [r1.data, r2.data].filter((d) => (d as { ok: boolean }).ok).length;
    expect(okCount).toBe(1);

    const after = await getAnnualUsed(admin, PRIYA);
    expect(after).toBe(before + 3); // only one approval spent the days
  });

  it("approval fails when the balance shrank after submit", async () => {
    // 5 working days, then we shrink the balance to 3 so it should fail.
    const id = await insertPendingRequest(
      admin,
      PRIYA,
      "annual",
      "2026-11-30",
      "2026-12-04",
      5,
      "Balance shrink test.",
    );

    // Shrink the annual balance to 3 remaining.
    await admin
      .from("leave_balances")
      .update({ allocated: 3, used: 0 })
      .eq("employee_id", PRIYA)
      .eq("year", new Date().getFullYear())
      .eq("leave_type", "annual");

    const { data, error } = await managerClient.rpc("approve_leave_request", {
      p_request_id: id,
      p_comment: "Should fail.",
    });
    expect(error).toBeNull();

    const result = data as { ok: boolean; error_code: string };
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("INSUFFICIENT_BALANCE");

    // Balance unchanged, request still pending.
    const stillPending = await admin
      .from("leave_requests")
      .select("status")
      .eq("id", id)
      .single();
    expect(stillPending.data?.status).toBe("pending");

    // Restore the seeded allocation for cleanliness.
    await admin
      .from("leave_balances")
      .update({ allocated: 20, used: 0 })
      .eq("employee_id", PRIYA)
      .eq("year", new Date().getFullYear())
      .eq("leave_type", "annual");
  });

  it("a manager who is not the direct manager cannot approve", async () => {
    const id = await insertPendingRequest(
      admin,
      PRIYA,
      "annual",
      "2026-12-07",
      "2026-12-09",
      3,
      "Skip-level manager test.",
    );

    const { data, error } = await skipLevelClient.rpc("approve_leave_request", {
      p_request_id: id,
      p_comment: "Should be forbidden.",
    });
    expect(error).toBeNull();

    const result = data as { ok: boolean; error_code: string };
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("FORBIDDEN");
  });

  it("an employee cannot approve their own request", async () => {
    // Use Neha (who has an auth account) for this self-approval test.
    const id = await insertPendingRequest(
      admin,
      NEHA,
      "annual",
      "2026-12-14",
      "2026-12-18",
      5,
      "Self-approval test.",
    );

    const before = await getAnnualUsed(admin, NEHA);

    const { data, error } = await employeeClient.rpc("approve_leave_request", {
      p_request_id: id,
      p_comment: "Trying to approve myself.",
    });
    expect(error).toBeNull();

    const result = data as { ok: boolean; error_code: string };
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("FORBIDDEN");

    const after = await getAnnualUsed(admin, NEHA);
    expect(after).toBe(before);
  });

  it("HR can approve any pending request", async () => {
    const id = await insertPendingRequest(
      admin,
      PRIYA,
      "annual",
      "2026-12-14",
      "2026-12-16",
      3,
      "HR approval test.",
    );

    const before = await getAnnualUsed(admin, PRIYA);

    const { data, error } = await hrClient.rpc("approve_leave_request", {
      p_request_id: id,
      p_comment: "HR approved.",
    });
    expect(error).toBeNull();

    const result = data as { ok: boolean; request: { decided_by: string } };
    expect(result.ok).toBe(true);
    expect(result.request.decided_by).toBe(ROHAN);

    const after = await getAnnualUsed(admin, PRIYA);
    expect(after).toBe(before + 3);
  });
});

describe("reject_leave_request", () => {
  it("leaves the balance unchanged and records the rejection", async () => {
    const id = await insertPendingRequest(
      admin,
      PRIYA,
      "casual",
      "2026-12-21",
      "2026-12-23",
      3,
      "Reject test — will be rejected.",
    );

    const before = await (async () => {
      const { data } = await admin
        .from("leave_balances")
        .select("used")
        .eq("employee_id", PRIYA)
        .eq("year", new Date().getFullYear())
        .eq("leave_type", "casual")
        .single();
      return Number(data?.used ?? 0);
    })();

    const { data, error } = await managerClient.rpc("reject_leave_request", {
      p_request_id: id,
      p_comment: "Not enough coverage that week.",
    });
    expect(error).toBeNull();

    const result = data as { ok: boolean; request: { status: string; decided_by: string } };
    expect(result.ok).toBe(true);
    expect(result.request.status).toBe("rejected");
    expect(result.request.decided_by).toBe(SANJAY);

    const { data: afterData } = await admin
      .from("leave_balances")
      .select("used")
      .eq("employee_id", PRIYA)
      .eq("year", new Date().getFullYear())
      .eq("leave_type", "casual")
      .single();
    expect(Number(afterData?.used ?? 0)).toBe(before);
  });

  it("reject requires a comment of at least 3 characters", async () => {
    const id = await insertPendingRequest(
      admin,
      PRIYA,
      "sick",
      "2026-12-28",
      "2026-12-30",
      3,
      "Short comment test.",
    );

    const { data, error } = await managerClient.rpc("reject_leave_request", {
      p_request_id: id,
      p_comment: "no",
    });
    expect(error).toBeNull();

    const result = data as { ok: boolean; error_code: string };
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("VALIDATION");
  });
});