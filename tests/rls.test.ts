/**
 * RLS integration tests.
 *
 * These run against the real Supabase project using a real signed-in session, so
 * they prove the policies actually hold — not that the client code remembers to
 * check. Every assertion is on an operation that must FAIL, so nothing is
 * written to the database.
 *
 * The people are resolved from `tests/fixtures.ts` by email rather than by a
 * hard-coded id: the demo dataset is reseeded from time to time, and a suite that
 * names retired ids fails for reasons that have nothing to do with the policy it
 * is checking. Anything that needs a specific request, employee or row count
 * reads it from the live database instead of assuming a shape.
 *
 *   npm test
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PEOPLE,
  createAdminClient,
  employeeId,
  signIn,
  CURRENT_YEAR,
} from "./fixtures";

/** Resolved once in `beforeAll`, because every test needs them by email. */
let NEHA: string;
let PRIYA: string;
let SANJAY: string;
let ADITYA: string;
let VIKRAM: string;
let ROHAN: string;

let employeeClient: SupabaseClient;
let managerClient: SupabaseClient;
let hrClient: SupabaseClient;

const admin = createAdminClient();

/** A pending request owned by Priya, i.e. one Neha must never be able to read. */
let someoneElsesRequest: string;
/** A pending request owned by Neha, i.e. one her manager must not be able to decide. */
let employeesOwnPendingRequest: string;

beforeAll(async () => {
  [NEHA, PRIYA, SANJAY, ADITYA, VIKRAM, ROHAN] = await Promise.all([
    employeeId(PEOPLE.neha),
    employeeId(PEOPLE.priya),
    employeeId(PEOPLE.engManager),
    employeeId(PEOPLE.ceo),
    employeeId(PEOPLE.salesManager),
    employeeId(PEOPLE.hr),
  ]);

  employeeClient = await signIn(PEOPLE.neha);
  managerClient = await signIn(PEOPLE.engManager);
  hrClient = await signIn(PEOPLE.hr);

  // Resolved rather than hard-coded so a reseed that changes the seeded request
  // ids — or the demo owner of a pending row — does not quietly turn these into
  // assertions on a row that no longer exists.
  const { data, error } = await admin
    .from("leave_requests")
    .select("id, employee_id")
    .eq("status", "pending");
  if (error) throw error;

  someoneElsesRequest = data.find((r) => r.employee_id === PRIYA)?.id ?? "";
  employeesOwnPendingRequest = data.find((r) => r.employee_id === NEHA)?.id ?? "";
  if (!someoneElsesRequest || !employeesOwnPendingRequest) {
    throw new Error(
      "The demo dataset has no pending request for Priya or Neha to test against — run `npm run db:seed-demo`.",
    );
  }
});

describe("employees table", () => {
  it("refuses INSERT from an employee-role session", async () => {
    const { error } = await employeeClient.from("employees").insert({
      name: "Mallory Insider",
      email: "mallory@orgflow.dev",
      role: "Tester",
      department: "Sales",
      join_date: "2026-01-05",
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501"); // insufficient_privilege
  });

  it("refuses UPDATE from an employee-role session, even on their own row", async () => {
    // Postgres reports a blocked UPDATE as "0 rows matched" rather than an
    // error, so the proof is that no row comes back and nothing changed.
    const { data, error } = await employeeClient
      .from("employees")
      .update({ app_role: "hr" })
      .eq("id", NEHA)
      .select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: detail } = await hrClient.rpc("get_employee_detail", {
      p_employee_id: NEHA,
    });
    expect((detail as { app_role: string }).app_role).toBe("employee");
  });

  it("refuses DELETE from an employee-role session", async () => {
    const { data, error } = await employeeClient
      .from("employees")
      .delete()
      .eq("id", PRIYA)
      .select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: stillThere } = await hrClient.rpc("get_employee_detail", {
      p_employee_id: PRIYA,
    });
    expect(stillThere).not.toBeNull();
  });

  it("hides columns outside the directory grant", async () => {
    const all = await employeeClient.from("employees").select("*").limit(1);
    expect(all.error).not.toBeNull();

    const email = await employeeClient.from("employees").select("email").limit(1);
    expect(email.error).not.toBeNull();

    const role = await employeeClient.from("employees").select("app_role").limit(1);
    expect(role.error).not.toBeNull();
  });

  it("still allows the directory columns to be read", async () => {
    const { data, error } = await employeeClient
      .from("employees")
      .select("id, name, photo, role, department, manager_id, join_date, is_active")
      .limit(3);
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
  });

  it("lets HR write", async () => {
    // Verified through the policy itself: the same write the employee could not
    // make must not error for HR. The value written back is the one already
    // there, so the demo dataset is left exactly as it was found.
    const { data: before } = await hrClient.rpc("get_employee_detail", {
      p_employee_id: NEHA,
    });
    const role = (before as { role: string }).role;

    const { error } = await hrClient.from("employees").update({ role }).eq("id", NEHA);
    expect(error).toBeNull();

    const { data: after } = await hrClient.rpc("get_employee_detail", {
      p_employee_id: NEHA,
    });
    expect((after as { role: string }).role).toBe(role);
  });
});

describe("leave_requests", () => {
  it("only returns the caller's own requests to an employee", async () => {
    const { data, error } = await employeeClient
      .from("leave_requests")
      .select("id, employee_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(new Set(data!.map((r) => r.employee_id))).toEqual(new Set([NEHA]));
  });

  it("does not expose another employee's request to an employee", async () => {
    const { data } = await employeeClient
      .from("leave_requests")
      .select("id")
      .eq("id", someoneElsesRequest);
    expect(data).toEqual([]);
  });

  it("refuses a direct status change by the request owner's manager", async () => {
    const { data: before } = await hrClient
      .from("leave_requests")
      .select("status")
      .eq("id", employeesOwnPendingRequest)
      .single();
    expect(before?.status).toBe("pending");

    // Sanjay is Neha's direct manager, so RLS lets him reach the row at all. The
    // refusal that matters is one layer down: `leave_requests_decision_fields`
    // will not accept a decided row without a decider, so a decision can only be
    // written by the audited RPCs and never by a bare UPDATE.
    const { data, error } = await managerClient
      .from("leave_requests")
      .update({ status: "approved" })
      .eq("id", employeesOwnPendingRequest)
      .select("id");
    expect(error).not.toBeNull();
    expect(data ?? []).toEqual([]);

    const { data: after } = await hrClient
      .from("leave_requests")
      .select("status")
      .eq("id", employeesOwnPendingRequest)
      .single();
    expect(after?.status).toBe("pending");
  });

  it("refuses an INSERT that is not for the caller or is not pending", async () => {
    const notMine = await employeeClient.from("leave_requests").insert({
      employee_id: PRIYA,
      leave_type: "casual",
      start_date: "2026-12-01",
      end_date: "2026-12-02",
      days: 2,
      status: "pending",
    });
    expect(notMine.error).not.toBeNull();

    const notPending = await employeeClient.from("leave_requests").insert({
      employee_id: NEHA,
      leave_type: "casual",
      start_date: "2026-12-01",
      end_date: "2026-12-02",
      days: 2,
      status: "approved",
    });
    expect(notPending.error).not.toBeNull();
  });
});

describe("role-scoped visibility", () => {
  it("scopes a manager to direct reports, not the whole subtree", async () => {
    // Aditya is the root of the seeded tree: Sanjay reports to him, and Neha
    // reports to Sanjay, so Neha is a grandchild. Authority follows the reporting
    // line and stops at one level — a manager never inherits their reports'
    // managers' authority.
    //
    // A grandchild's *request* can still reach a senior manager for one reason
    // only: the manager is named on its approval chain (0004b widens `can_manage`
    // so a level-2 department head can read what they must sign). That is an
    // approval grant, not a reporting-line one, which is why it is asserted here
    // on `is_manager_of` — the pure reporting question — and not on the queue.
    const { data: isDirect } = await admin
      .from("employees")
      .select("manager_id")
      .eq("id", SANJAY)
      .single();
    expect(isDirect?.manager_id).toBe(ADITYA);

    const adityaClient = await signIn(PEOPLE.ceo);
    const { data: seesReport } = await adityaClient.rpc("is_manager_of", {
      p_employee_id: SANJAY,
    });
    expect(seesReport).toBe(true);

    for (const grandchild of [NEHA, PRIYA]) {
      const { data: seesGrandchild } = await adityaClient.rpc("is_manager_of", {
        p_employee_id: grandchild,
      });
      expect(seesGrandchild).toBe(false);
    }
  });

  it("gives a manager only their own team's requests", async () => {
    // Sanjay manages Neha and Priya and nothing else. Vikram heads Sales, a peer
    // team, so none of his requests are visible — nor is anyone else's.
    const { data, error } = await managerClient
      .from("leave_requests")
      .select("id, employee_id");
    expect(error).toBeNull();
    const visible = new Set(data!.map((r) => r.employee_id));
    expect(visible.has(NEHA)).toBe(true);
    expect(visible.has(PRIYA)).toBe(true);
    expect(visible.has(VIKRAM)).toBe(false); // peer manager, unrelated department
    expect(visible.has(ROHAN)).toBe(false); // reports to the CEO, not to Sanjay
  });

  it("gives HR the whole table", async () => {
    const { data, error } = await hrClient.from("leave_requests").select("id");
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(3);
  });

  it("scopes leave_balances to self, reports, or HR", async () => {
    const asEmployee = await employeeClient
      .from("leave_balances")
      .select("id, employee_id")
      .eq("year", CURRENT_YEAR);
    expect(new Set(asEmployee.data!.map((b) => b.employee_id))).toEqual(new Set([NEHA]));

    // HR sees every ledger row there is. Counted from the service-role read
    // rather than hard-coded, so a reseed that adds or drops a person does not
    // turn this into an assertion about the size of the demo team.
    const { data: all } = await admin
      .from("leave_balances")
      .select("id")
      .eq("year", CURRENT_YEAR);
    const asHr = await hrClient
      .from("leave_balances")
      .select("id")
      .eq("year", CURRENT_YEAR);
    expect(asHr.error).toBeNull();
    expect(asHr.data!.length).toBe(all!.length);
    expect(asHr.data!.length).toBeGreaterThan(asEmployee.data!.length);
  });
});

describe("get_employee_detail", () => {
  it("returns the full record for yourself", async () => {
    const { data } = await employeeClient.rpc("get_employee_detail", {
      p_employee_id: NEHA,
    });
    const row = data as Record<string, unknown>;
    expect(row.email).toBe(PEOPLE.neha);
    expect(row.auth_user_id).toBeUndefined();
  });

  it("returns directory fields only for someone else", async () => {
    // Priya is a peer, not a report, so Neha gets the directory projection and
    // nothing more — not the email, not the app role.
    const { data: directory } = await admin
      .from("employees")
      .select("name")
      .eq("id", PRIYA)
      .single();

    const { data } = await employeeClient.rpc("get_employee_detail", {
      p_employee_id: PRIYA,
    });
    const row = data as Record<string, unknown>;
    expect(row.name).toBe(directory?.name);
    expect(row.email).toBeUndefined();
    expect(row.app_role).toBeUndefined();
  });

  it("returns the full record for HR", async () => {
    const { data } = await hrClient.rpc("get_employee_detail", {
      p_employee_id: PRIYA,
    });
    expect((data as Record<string, unknown>).email).toBe(PEOPLE.priya);
  });
});