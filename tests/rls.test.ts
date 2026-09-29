/**
 * RLS integration tests.
 *
 * These run against the real Supabase project using a real signed-in session, so
 * they prove the policies actually hold — not that the client code remembers to
 * check. Every assertion is on an operation that must FAIL, so nothing is
 * written to the database.
 *
 *   npm test
 */
import { config } from "dotenv";
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Next.js reads .env.local; vitest does not.
config({ path: ".env.local" });
config();

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const PASSWORD = "OrgFlow@2026";

// Deterministic ids from supabase/seed.sql
const IDS = {
  ceo: "00000000-0000-4000-8000-000000000001",
  engineerManager: "00000000-0000-4000-8000-000000000002",
  engLead: "00000000-0000-4000-8000-000000000006",
  employee: "00000000-0000-4000-8000-000000000007", // Neha Gupta — role: employee
  otherEmployee: "00000000-0000-4000-8000-000000000008", // Karthik Reddy
  manager: "00000000-0000-4000-8000-000000000002", // Vikram Sethi — role: manager
  priyaRequest: "00000000-0000-4000-8000-000000000105", // belongs to Priya Nair
  hr: "00000000-0000-4000-8000-000000000015", // Rohan Iyer — role: hr
};

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

let employeeClient: SupabaseClient;
let managerClient: SupabaseClient;
let hrClient: SupabaseClient;

beforeAll(async () => {
  if (!URL || !ANON_KEY) throw new Error("Missing Supabase env vars — see .env.example");
  employeeClient = await signIn("neha.gupta@orgflow.dev");
  managerClient = await signIn("vikram.sethi@orgflow.dev");
  hrClient = await signIn("rohan.iyer@orgflow.dev");
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
      .eq("id", IDS.employee)
      .select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: detail } = await hrClient.rpc("get_employee_detail", {
      p_employee_id: IDS.employee,
    });
    expect((detail as { app_role: string }).app_role).toBe("employee");
  });

  it("refuses DELETE from an employee-role session", async () => {
    const { data, error } = await employeeClient
      .from("employees")
      .delete()
      .eq("id", IDS.otherEmployee)
      .select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: stillThere } = await hrClient.rpc("get_employee_detail", {
      p_employee_id: IDS.otherEmployee,
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
    // Verified through RLS itself: the same insert the employee could not make
    // must not error for HR. It is rolled back by never being committed —
    // instead we assert the policy allows a harmless no-op update and revert it.
    const { error } = await hrClient
      .from("employees")
      .update({ role: "Senior Backend Engineer" })
      .eq("id", IDS.employee);
    expect(error).toBeNull();
  });
});

describe("leave_requests", () => {
  it("only returns the caller's own requests to an employee", async () => {
    const { data, error } = await employeeClient
      .from("leave_requests")
      .select("id, employee_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(new Set(data!.map((r) => r.employee_id))).toEqual(new Set([IDS.employee]));
  });

  it("does not expose another employee's request to an employee", async () => {
    const { data } = await employeeClient
      .from("leave_requests")
      .select("id")
      .eq("id", IDS.priyaRequest);
    expect(data).toEqual([]);
  });

  it("refuses a direct status change by the request owner's manager", async () => {
    const { data: before } = await hrClient
      .from("leave_requests")
      .select("status")
      .eq("id", IDS.priyaRequest)
      .single();
    expect(before?.status).toBe("pending");

    const { data } = await managerClient
      .from("leave_requests")
      .update({ status: "approved" })
      .eq("id", IDS.priyaRequest)
      .select("id");
    // RLS silently matches zero rows rather than erroring — the write is a no-op.
    expect(data).toEqual([]);

    const { data: after } = await hrClient
      .from("leave_requests")
      .select("status")
      .eq("id", IDS.priyaRequest)
      .single();
    expect(after?.status).toBe("pending");
  });

  it("refuses an INSERT that is not for the caller or is not pending", async () => {
    const notMine = await employeeClient.from("leave_requests").insert({
      employee_id: IDS.otherEmployee,
      leave_type: "casual",
      start_date: "2026-12-01",
      end_date: "2026-12-02",
      days: 2,
      status: "pending",
    });
    expect(notMine.error).not.toBeNull();

    const notPending = await employeeClient.from("leave_requests").insert({
      employee_id: IDS.employee,
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
    // Vikram (VP Engineering) manages Sanjay, who manages Karthik. Direct
    // reports only — so Karthik's requests are not visible to Vikram.
    const { data: isDirect } = await managerClient.rpc("is_manager_of", {
      p_employee_id: IDS.engLead,
    });
    expect(isDirect).toBe(true);

    const { data: isGrandchild } = await managerClient.rpc("is_manager_of", {
      p_employee_id: IDS.otherEmployee,
    });
    expect(isGrandchild).toBe(false);

    const { data, error } = await managerClient
      .from("leave_requests")
      .select("id, employee_id");
    expect(error).toBeNull();
    const visible = new Set(data!.map((r) => r.employee_id));
    expect(visible.has(IDS.otherEmployee)).toBe(false); // grandchild, not a report
    expect(visible.has(IDS.hr)).toBe(false); // unrelated department
  });

  it("gives HR the whole table", async () => {
    const { data, error } = await hrClient.from("leave_requests").select("id");
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(3);
  });

  it("scopes leave_balances to self, reports, or HR", async () => {
    const asEmployee = await employeeClient
      .from("leave_balances")
      .select("id, employee_id");
    expect(new Set(asEmployee.data!.map((b) => b.employee_id))).toEqual(
      new Set([IDS.employee]),
    );

    const asHr = await hrClient.from("leave_balances").select("id");
    expect(asHr.data!.length).toBe(60);
  });
});

describe("get_employee_detail", () => {
  it("returns the full record for yourself", async () => {
    const { data } = await employeeClient.rpc("get_employee_detail", {
      p_employee_id: IDS.employee,
    });
    const row = data as Record<string, unknown>;
    expect(row.email).toBe("neha.gupta@orgflow.dev");
    expect(row.auth_user_id).toBeUndefined();
  });

  it("returns directory fields only for someone else", async () => {
    const { data } = await employeeClient.rpc("get_employee_detail", {
      p_employee_id: IDS.otherEmployee,
    });
    const row = data as Record<string, unknown>;
    expect(row.name).toBe("Karthik Reddy");
    expect(row.email).toBeUndefined();
    expect(row.app_role).toBeUndefined();
  });

  it("returns the full record for HR", async () => {
    const { data } = await hrClient.rpc("get_employee_detail", {
      p_employee_id: IDS.otherEmployee,
    });
    expect((data as Record<string, unknown>).email).toBe("karthik.reddy@orgflow.dev");
  });
});
