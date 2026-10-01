/**
 * Phase 3.5 — hierarchical leave approval.
 *
 * The chain is built and enforced in Postgres: `build_approval_chain` resolves the
 * approvers at submission, and `approve_leave_request` / `reject_leave_request`
 * settle one step at a time. These tests drive those RPCs through real signed-in
 * sessions (so `current_employee_id()` is genuine), then assert on the rows
 * directly with the service-role client.
 *
 * Subjects, chosen so the chain has genuinely distinct approvers to assert on:
 *   Neha Gupta    employee, Engineering → Sanjay (manager) → Aditya (dept head) → Rohan (HR)
 *   Priya Nair    employee, Engineering, used where Neha's windows are already taken
 *   Vikram Sethi  manager whose dept head IS his manager, so level 2 is `skipped`
 *   Aditya Rao    root of the tree, so nothing can route his leave → `approval_blocked`
 *   Fatima Sheikh Sales, used to prove a manager outside the chain is refused
 *
 * Every test uses its own date window. Overlap is refused by the database even
 * between two requests of the same employee, so sharing a window would make one
 * test's pending row break the next.
 *
 * `casual` balances are zeroed in beforeAll and restored in afterAll, because an
 * approval spends a real balance and deleting the request afterwards does not
 * refund it. That also makes the file independent of what other suites have spent.
 *
 *   npm test
 */
import { config } from "dotenv";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../server/supabase/admin-core";
import type { LeaveType } from "@/shared/types";

// Load the dedicated test project's credentials before `.env.local`.
//
// dotenv never overwrites a variable that is already set, so loading the test
// file first makes it win, while `.env.local` still supplies anything else the
// suites read (the LLM keys, for instance). Without this the suites would run
// against the demo project, whose eight-person dataset is a different
// organisation from the 15-person seed they assert on — and approving leave in
// them would spend real demo balances.
config({ path: ".env.test.local" });
config({ path: ".env.local" });
config();

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const PASSWORD = "OrgFlow@2026";

const ADITYA = "00000000-0000-4000-8000-000000000001"; // Engineering dept head, root of tree
const VIKRAM = "00000000-0000-4000-8000-000000000002"; // his dept head is his own manager
const SANJAY = "00000000-0000-4000-8000-000000000006"; // Neha's and Priya's manager
const NEHA = "00000000-0000-4000-8000-000000000007";
const PRIYA = "00000000-0000-4000-8000-000000000009";
const NIKHIL = "00000000-0000-4000-8000-000000000012"; // Fatima's manager (Sales)
const ROHAN = "00000000-0000-4000-8000-000000000015"; // HR

/** Employees whose casual balance this file spends. */
const SUBJECTS = [ADITYA, VIKRAM, NEHA, PRIYA];

const admin = createAdminClient();

/** `employeeId` → the `used` value to put back in afterAll. */
const originalUsed = new Map<string, number>();

/**
 * Cleanups queued by the test currently running. Run after EVERY test rather than
 * at the end of the file, so a request never outlives the assertion that needed
 * it. That isolation is what lets tests reuse a date window: the database refuses
 * any overlap with a request that still exists, and self-cleanup means no earlier
 * test is still holding one.
 */
const queued: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const undo of queued.splice(0)) await undo();
});

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

type Created = {
  id: string;
  days: number;
  approval_blocked?: boolean;
  approval_blocked_reason?: string | null;
  current_approval_level?: number | null;
};

/** Submits through the real RPC, so the chain is built exactly as in production. */
async function submit(
  email: string,
  leaveType: LeaveType,
  start: string,
  end: string,
  reason: string,
): Promise<Created> {
  const client = await signIn(email);
  const { data, error } = await client.rpc("create_leave_request", {
    p_leave_type: leaveType,
    p_start: start,
    p_end: end,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);
  if (!data?.valid) {
    throw new Error(`could not create request: ${data?.error_code} ${data?.error_message}`);
  }
  if (data.id) void track(data.id, Number(data.days), Number(start.slice(0, 4)));
  return data as Created;
}

/**
 * Queues removal of `requestId` and restoration of the balance it may have spent.
 *
 * An approval debits the ledger, and deleting the request row afterwards does not
 * credit it back — so the snapshot taken here is the only way the suite leaves the
 * database as it found it.
 */
async function track(requestId: string, days: number, year: number) {
  const { data: request } = await admin
    .from("leave_requests")
    .select("employee_id, leave_type")
    .eq("id", requestId)
    .maybeSingle();
  if (!request) return;

  const { data: balance } = await admin
    .from("leave_balances")
    .select("id, used")
    .eq("employee_id", request.employee_id)
    .eq("year", year)
    .eq("leave_type", request.leave_type)
    .maybeSingle();
  const usedAtSubmit = Number(balance?.used ?? 0);

  queued.push(async () => {
    await admin.from("leave_requests").delete().eq("id", requestId);
    if (balance) {
      await admin
        .from("leave_balances")
        .update({ used: usedAtSubmit })
        .eq("id", balance.id);
    }
  });
}

type Step = {
  level: number;
  approver_employee_id: string;
  approver_role: string;
  status: string;
  comment: string | null;
};

async function steps(requestId: string): Promise<Step[]> {
  const { data, error } = await admin
    .from("leave_approval_steps")
    .select("level, approver_employee_id, approver_role, status, comment")
    .eq("leave_request_id", requestId)
    .order("level");
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function requestRow(requestId: string) {
  const { data, error } = await admin
    .from("leave_requests")
    .select("status, current_approval_level, blocked_reason, decided_by")
    .eq("id", requestId)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function usedOf(employeeId: string, leaveType: LeaveType) {
  const { data } = await admin
    .from("leave_balances")
    .select("used")
    .eq("employee_id", employeeId)
    .eq("year", 2026)
    .eq("leave_type", leaveType)
    .maybeSingle();
  return Number(data?.used ?? 0);
}

const casualUsed = (employeeId: string) => usedOf(employeeId, "casual");
const annualUsed = (employeeId: string) => usedOf(employeeId, "annual");

type Decision = {
  ok: boolean;
  error_code: string | null;
  error_message: string | null;
  final_approval?: boolean;
  awaiting_level?: number | null;
  request: { status: string };
};

async function approve(email: string, requestId: string, comment: string | null = null) {
  const client = await signIn(email);
  const { data, error } = await client.rpc("approve_leave_request", {
    p_request_id: requestId,
    p_comment: comment,
  });
  if (error) throw new Error(error.message);
  return data as Decision;
}

async function reject(email: string, requestId: string, comment: string) {
  const client = await signIn(email);
  const { data, error } = await client.rpc("reject_leave_request", {
    p_request_id: requestId,
    p_comment: comment,
  });
  if (error) throw new Error(error.message);
  return data as Decision;
}

beforeAll(async () => {
  // Recorded first, then zeroed, so the restore value is the pre-suite state and
  // the run does not depend on how much another file already spent.
  for (const employeeId of SUBJECTS) {
    originalUsed.set(employeeId, await casualUsed(employeeId));
    await admin
      .from("leave_balances")
      .update({ used: 0 })
      .eq("employee_id", employeeId)
      .eq("year", 2026)
      .eq("leave_type", "casual");
  }
});

afterAll(async () => {
  // Safety net: afterEach normally removes everything, so anything left here
  // means a test threw before queuing its cleanup.
  for (const undo of queued.splice(0)) await undo();
  for (const [employeeId, used] of originalUsed) {
    await admin
      .from("leave_balances")
      .update({ used })
      .eq("employee_id", employeeId)
      .eq("year", 2026)
      .eq("leave_type", "casual");
  }
});

describe("3.5.1 the chain a request is given", () => {
  it("routes 1-3 working days to the direct manager only", async () => {
    const request = await submit(
      "neha.gupta@orgflow.dev",
      "casual",
      "2026-12-01",
      "2026-12-02",
      "Two day leave should need exactly one signature.",
    );
    expect(request.days).toBe(2);
    expect(request.current_approval_level).toBe(1);

    const chain = await steps(request.id);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({
      level: 1,
      approver_employee_id: SANJAY,
      approver_role: "manager",
      status: "pending",
    });
    await expect(requestRow(request.id)).resolves.toMatchObject({
      status: "pending",
      current_approval_level: 1,
    });
  });

  it("routes 4-7 working days to manager then department head", async () => {
    const request = await submit(
      "neha.gupta@orgflow.dev",
      "casual",
      "2026-12-07",
      "2026-12-11",
      "Five day leave should need a second signature from the department head.",
    );
    expect(request.days).toBe(5);

    const chain = await steps(request.id);
    expect(chain).toHaveLength(2);
    // The department head is derived from employees.manager_id — the topmost
    // Engineering ancestor of Neha — not hard-coded anywhere in the app.
    expect(chain[0]).toMatchObject({ level: 1, approver_employee_id: SANJAY, approver_role: "manager" });
    expect(chain[1]).toMatchObject({
      level: 2,
      approver_employee_id: ADITYA,
      approver_role: "department_head",
      status: "pending",
    });
  });

  it("routes 8+ working days to manager, department head, then HR", async () => {
    const request = await submit(
      "neha.gupta@orgflow.dev",
      "casual",
      "2026-11-02",
      "2026-11-13",
      "Ten day leave should need all three signatures in order.",
    );
    expect(request.days).toBe(10);

    const chain = await steps(request.id);
    expect(chain).toHaveLength(3);
    expect(chain.map((s) => s.approver_employee_id)).toEqual([SANJAY, ADITYA, ROHAN]);
    expect(chain.map((s) => s.approver_role)).toEqual(["manager", "department_head", "hr"]);
    expect(chain.every((s) => s.status === "pending")).toBe(true);
  });

  it("marks a level skipped when the department head is already the manager", async () => {
    // Vikram reports to Aditya and both are Engineering, so the department head and
    // the direct manager are the same person: one signature, not two.
    const request = await submit(
      "vikram.sethi@orgflow.dev",
      "casual",
      "2026-12-14",
      "2026-12-18",
      "Five days where the manager is also the department head.",
    );
    const chain = await steps(request.id);
    expect(chain).toHaveLength(2);
    expect(chain[0]).toMatchObject({
      approver_employee_id: ADITYA,
      approver_role: "manager",
      status: "pending",
    });
    expect(chain[1]).toMatchObject({ approver_role: "department_head", status: "skipped" });
  });
});

describe("3.5.2 approving walks the chain and spends once", () => {
  it("2-day leave: manager approval approves the request", async () => {
    const before = await casualUsed(NEHA);
    const request = await submit(
      "neha.gupta@orgflow.dev",
      "casual",
      "2026-10-19",
      "2026-10-20",
      "Short leave that the manager can decide outright.",
    );

    const result = await approve("sanjay.kapoor@orgflow.dev", request.id, "Fine, enjoy.");
    expect(result.ok).toBe(true);
    // One level means that one signature IS the final approval.
    expect(result.final_approval).toBe(true);
    expect(result.request.status).toBe("approved");

    expect((await requestRow(request.id)).status).toBe("approved");
    expect(await casualUsed(NEHA)).toBe(before + 2);
  });

  it("5-day leave: manager then department head, approved at the second signature", async () => {
    const before = await casualUsed(NEHA);
    const request = await submit(
      "neha.gupta@orgflow.dev",
      "casual",
      "2026-11-16",
      "2026-11-20",
      "Five days needing two signatures before the leave is granted.",
    );

    const first = await approve("sanjay.kapoor@orgflow.dev", request.id, "Agreed at my level.");
    expect(first.ok).toBe(true);
    expect(first.final_approval).toBe(false);
    expect(first.awaiting_level).toBe(2);
    expect(first.request.status).toBe("pending");
    // A mid-chain signature must not touch the balance.
    expect(await casualUsed(NEHA)).toBe(before);

    const second = await approve("aditya.rao@orgflow.dev", request.id, "Endorsed at department level.");
    expect(second.ok).toBe(true);
    expect(second.final_approval).toBe(true);
    expect(second.request.status).toBe("approved");

    expect((await requestRow(request.id)).status).toBe("approved");
    expect(await casualUsed(NEHA)).toBe(before + 5);

    const chain = await steps(request.id);
    expect(chain.map((s) => s.status)).toEqual(["approved", "approved"]);
    expect(chain.map((s) => s.approver_employee_id)).toEqual([SANJAY, ADITYA]);
  });

  it("10-day leave: manager, department head, then HR, approved at the third signature", async () => {
    const before = await annualUsed(NEHA);
    const request = await submit(
      "neha.gupta@orgflow.dev",
      "annual",
      "2026-11-02",
      "2026-11-13",
      "Ten days needing the full three level chain.",
    );

    for (const [email, nextLevel] of [
      ["sanjay.kapoor@orgflow.dev", 2],
      ["aditya.rao@orgflow.dev", 3],
    ] as const) {
      const result = await approve(email, request.id, "Moving up the chain.");
      expect(result.ok).toBe(true);
      expect(result.final_approval).toBe(false);
      expect(result.awaiting_level).toBe(nextLevel);
      expect(result.request.status).toBe("pending");
      expect(await annualUsed(NEHA)).toBe(before);
    }

    const finalResult = await approve("rohan.iyer@orgflow.dev", request.id, "Approved by HR.");
    expect(finalResult.ok).toBe(true);
    expect(finalResult.final_approval).toBe(true);
    expect(finalResult.awaiting_level).toBeNull();
    expect(finalResult.request.status).toBe("approved");

    // Only the third signature spends the ledger, and it spends it once.
    expect(request.days).toBe(10);
    expect(await annualUsed(NEHA)).toBe(before + 10);
    const chain = await steps(request.id);
    expect(chain.map((s) => s.status)).toEqual(["approved", "approved", "approved"]);
  });

  it("spends the balance exactly once even if the final approver is asked twice", async () => {
    const before = await casualUsed(NEHA);
    const request = await submit(
      "neha.gupta@orgflow.dev",
      "casual",
      "2026-12-21",
      "2026-12-22",
      "Double decision attempt should not double spend the balance.",
    );

    const first = await approve("sanjay.kapoor@orgflow.dev", request.id, "Yes.");
    expect(first.ok).toBe(true);
    expect(first.final_approval).toBe(true);
    expect(await casualUsed(NEHA)).toBe(before + 2);

    // The request is no longer pending, so the second attempt is refused and the
    // ledger must not move again.
    const second = await approve("sanjay.kapoor@orgflow.dev", request.id, "Yes again.");
    expect(second.ok).toBe(false);
    expect(second.error_code).toBe("VALIDATION");
    expect(await casualUsed(NEHA)).toBe(before + 2);
  });
});

describe("3.5.3 rejection ends the request at any level", () => {
  it("rejection at level 1 rejects the request and leaves the balance alone", async () => {
    const before = await casualUsed(NEHA);
    const request = await submit(
      "neha.gupta@orgflow.dev",
      "casual",
      "2026-12-03",
      "2026-12-04",
      "Rejected at the manager level for testing.",
    );

    const result = await reject("sanjay.kapoor@orgflow.dev", request.id, "Too close to release week.");
    expect(result.ok).toBe(true);

    const row = await requestRow(request.id);
    expect(row.status).toBe("rejected");
    expect(row.current_approval_level).toBeNull();
    expect(await casualUsed(NEHA)).toBe(before);

    const chain = await steps(request.id);
    expect(chain[0]).toMatchObject({ status: "rejected" });
    expect(chain[0].comment).toBe("Too close to release week.");
  });

  it("rejection at the middle level rejects it and abandons the later steps", async () => {
    const before = await casualUsed(NEHA);
    // A 10-working-day request, so there is a level 3 after the one that rejects.
    const request = await submit(
      "neha.gupta@orgflow.dev",
      "casual",
      "2026-11-02",
      "2026-11-13",
      "Rejected at the department head level with an HR step still to come.",
    );
    expect(request.days).toBe(10);

    await approve("sanjay.kapoor@orgflow.dev", request.id, "Fine at my level.");
    expect(await casualUsed(NEHA)).toBe(before);

    const result = await reject("aditya.rao@orgflow.dev", request.id, "Two teams are already short.");
    expect(result.ok).toBe(true);
    expect((await requestRow(request.id)).status).toBe("rejected");
    // The HR step must not be left dangling as if it were still live.
    expect(await casualUsed(NEHA)).toBe(before);

    const chain = await steps(request.id);
    expect(chain.map((s) => s.status)).toEqual(["approved", "rejected", "skipped"]);
  });
});

describe("3.5.4 only the assigned approver may act", () => {
  it("refuses an employee approving their own leave", async () => {
    const request = await submit(
      "neha.gupta@orgflow.dev",
      "casual",
      "2026-11-04",
      "2026-11-05",
      "Attempt to self approve should be refused by the database.",
    );

    const result = await approve("neha.gupta@orgflow.dev", request.id, "Self approval.");
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("FORBIDDEN");
    expect((await requestRow(request.id)).status).toBe("pending");
  });

  it("refuses a manager acting outside their own chain", async () => {
    // Sanjay is Engineering; Fatima is Sales. He holds no step on her request.
    const request = await submit(
      "fatima.sheikh@orgflow.dev",
      "unpaid",
      "2026-12-01",
      "2026-12-02",
      "Request owned by a different team entirely.",
    );
    const chain = await steps(request.id);
    expect(chain[0].approver_employee_id).toBe(NIKHIL);

    const result = await approve("sanjay.kapoor@orgflow.dev", request.id, "Not my team, but approving.");
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("FORBIDDEN");
    expect((await requestRow(request.id)).status).toBe("pending");
  });

  it("refuses the department head jumping ahead of the manager", async () => {
    // Aditya holds level 2 while level 1 is still Sanjay's, so he must not be able
    // to sign the request early.
    const request = await submit(
      "priya.nair@orgflow.dev",
      "casual",
      "2026-12-07",
      "2026-12-11",
      "Department head must wait for the manager step to clear.",
    );

    const result = await approve("aditya.rao@orgflow.dev", request.id, "Signing early.");
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("FORBIDDEN");
    expect((await requestRow(request.id)).current_approval_level).toBe(1);
  });
});

describe("3.5.5 concurrency", () => {
  it("two concurrent approvals on the same step cannot both succeed", async () => {
    const before = await casualUsed(PRIYA);
    const request = await submit(
      "priya.nair@orgflow.dev",
      "casual",
      "2026-12-14",
      "2026-12-15",
      "Two approvals racing the same step should not double spend.",
    );

    // Both calls target the one active step. The request row is locked FOR UPDATE,
    // so one wins and the other re-reads a status it can no longer act on.
    const [a, b] = await Promise.all([
      approve("sanjay.kapoor@orgflow.dev", request.id, "Approved by manager."),
      approve("sanjay.kapoor@orgflow.dev", request.id, "Approved by manager again."),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].error_code).toBe("VALIDATION");

    // The decisive assertion: the ledger moved once, not twice.
    expect(await casualUsed(PRIYA)).toBe(before + 2);

    const chain = await steps(request.id);
    expect(chain.filter((s) => s.status === "approved")).toHaveLength(1);
  });
});

describe("3.5.6 history survives a hierarchy change", () => {
  it("changing the employee's manager does not rewrite an existing chain", async () => {
    const request = await submit(
      "neha.gupta@orgflow.dev",
      "casual",
      "2026-12-14",
      "2026-12-15",
      "Chain frozen before the reporting line is reorganised.",
    );

    const before = await steps(request.id);
    expect(before[0].approver_employee_id).toBe(SANJAY);

    // Reorganise: Neha now reports to Vikram instead.
    const { error: moveError } = await admin
      .from("employees")
      .update({ manager_id: VIKRAM })
      .eq("id", NEHA);
    if (moveError) throw new Error(moveError.message);

    try {
      const after = await steps(request.id);
      expect(after).toEqual(before);
      expect(after[0].approver_employee_id).toBe(SANJAY);

      // And the frozen chain is the one that executes. The new manager is refused
      // first, while the request is still pending — checking afterwards would only
      // prove it was already decided.
      const newManager = await approve(
        "vikram.sethi@orgflow.dev",
        request.id,
        "Signing on the new chain.",
      );
      expect(newManager.ok).toBe(false);
      expect(newManager.error_code).toBe("FORBIDDEN");

      // The manager named when it was submitted still holds the step.
      const staleManager = await approve(
        "sanjay.kapoor@orgflow.dev",
        request.id,
        "Signing on the old chain.",
      );
      expect(staleManager.ok).toBe(true);
    } finally {
      // Always restore, or every later test inherits a different org chart.
      const { error: restoreError } = await admin
        .from("employees")
        .update({ manager_id: SANJAY })
        .eq("id", NEHA);
      if (restoreError) throw new Error(restoreError.message);
    }
  });

  it("a request submitted after the change uses the new reporting line", async () => {
    const { error } = await admin.from("employees").update({ manager_id: VIKRAM }).eq("id", NEHA);
    if (error) throw new Error(error.message);

    try {
      const request = await submit(
        "neha.gupta@orgflow.dev",
        "casual",
        "2026-12-16",
        "2026-12-18",
        "Chain built after the reporting line changed.",
      );
      const chain = await steps(request.id);
      expect(chain[0].approver_employee_id).toBe(VIKRAM);
    } finally {
      const { error: restoreError } = await admin
        .from("employees")
        .update({ manager_id: SANJAY })
        .eq("id", NEHA);
      if (restoreError) throw new Error(restoreError.message);
    }
  });
});

describe("3.5.7 an unresolvable chain is blocked, never auto-approved", () => {
  it("marks a request approval_blocked when there is no direct manager", async () => {
    // Aditya is the root of the reporting tree, so nothing can route his leave.
    const request = await submit(
      "aditya.rao@orgflow.dev",
      "casual",
      "2026-12-01",
      "2026-12-02",
      "Request with no possible first approver.",
    );

    expect(request.approval_blocked).toBe(true);
    expect(request.approval_blocked_reason).toMatch(/no direct manager/i);

    const row = await requestRow(request.id);
    expect(row.status).toBe("approval_blocked");
    expect(row.current_approval_level).toBeNull();
    // Blocked is a real status, not a missing decision: the reason has to be
    // readable by the person who submitted it.
    expect(row.blocked_reason).toMatch(/no direct manager/i);
  });

  it("only HR can clear a blocked request, and doing so spends the balance once", async () => {
    const request = await submit(
      "aditya.rao@orgflow.dev",
      "casual",
      "2026-12-03",
      "2026-12-04",
      "Second blocked request for the HR override path.",
    );
    const before = await casualUsed(ADITYA);

    // A manager who is not HR cannot clear it.
    const notHr = await approve("sanjay.kapoor@orgflow.dev", request.id, "Trying to override.");
    expect(notHr.ok).toBe(false);
    expect(notHr.error_code).toBe("FORBIDDEN");

    const override = await approve("rohan.iyer@orgflow.dev", request.id, "HR override, approved.");
    expect(override.ok).toBe(true);
    expect(override.final_approval).toBe(true);
    expect((await requestRow(request.id)).status).toBe("approved");
    expect(await casualUsed(ADITYA)).toBe(before + 2);

    // The override is recorded as a real step, so the history is not a special case.
    const chain = await steps(request.id);
    expect(
      chain.some((s) => s.approver_employee_id === ROHAN && s.status === "approved"),
    ).toBe(true);
  });
});
