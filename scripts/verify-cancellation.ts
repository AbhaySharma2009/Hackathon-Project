/**
 * Verifies the cancellation rules in `0011_cancel_leave.sql`.
 *
 * The interesting cases are the ones that must be *refused*, because a cancel
 * that is too permissive silently deletes somebody's approval work. Each refusal
 * is checked with a real user session, not the service role, so RLS and
 * `current_employee_id()` are genuinely exercised.
 *
 * Run: npm run verify:cancel
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "../server/supabase/admin-core";

config({ path: ".env.local" });
config();

const PASSWORD = "OrgFlow@2026";

const EMPLOYEE_EMAIL = "neha.gupta@orgflow.dev";
const HR_EMAIL = "rohan.iyer@orgflow.dev";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

async function asUser(email: string) {
  // The anon key, deliberately: this is the posture a real browser has, so RLS
  // and `current_employee_id()` are genuinely exercised.
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return { client };
}

/** Creates a pending request for `employeeId` and returns its id. */
async function makeRequest(employeeId: string, daysFromNow: number) {
  const A = createAdminClient();
  const start = new Date();
  start.setDate(start.getDate() + daysFromNow);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const { data, error } = await A
    .from("leave_requests")
    .insert({
      employee_id: employeeId,
      leave_type: "casual",
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
      days: 2,
      reason: "cancel verification fixture",
      status: "pending",
    })
    .select("id, status")
    .single();
  if (error) throw new Error(`fixture insert failed: ${error.message}`);
  return data.id;
}

/**
 * Creates a request the way the app does — through `create_leave_request` as the
 * requester — so a real approval chain is built. Inserting the row directly with
 * the service role would skip chain construction and make the "steps are skipped"
 * assertion vacuously true.
 */
async function makeRealRequest(email: string, employeeId: string, daysFromNow: number) {
  const { client } = await asUser(email);
  const start = new Date();
  start.setDate(start.getDate() + daysFromNow);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const { data, error } = await client.rpc("create_leave_request", {
    p_leave_type: "casual",
    p_start: start.toISOString().slice(0, 10),
    p_end: end.toISOString().slice(0, 10),
    p_reason: "cancel verification fixture",
  });
  if (error) throw new Error(`create_leave_request failed: ${error.message}`);

  const id = (data as { request_id?: string }).request_id ?? (data as { id?: string }).id;
  if (!id) throw new Error(`no request id returned: ${JSON.stringify(data)}`);
  void employeeId;
  return { id, client };
}

/** A stable fingerprint of one employee's balances, for before/after comparison. */
async function balanceFingerprint(employeeId: string) {
  const A = createAdminClient();
  const { data } = await A
    .from("leave_balances")
    .select("leave_type, year, allocated, used")
    .eq("employee_id", employeeId)
    .order("leave_type");
  return JSON.stringify(data ?? []);
}

async function main() {
  const A = createAdminClient();

  // People are resolved by email rather than by a hardcoded uuid, so this keeps
  // working when the demo fixtures are reseeded.
  const { data: employees } = await A.from("employees").select("id, email, name");
  const idOf = (email: string) => {
    const hit = employees?.find((e) => e.email === email);
    if (!hit) throw new Error(`demo employee not found: ${email}`);
    return hit.id;
  };
  const NEHA = idOf(EMPLOYEE_EMAIL);

  console.log("\ncancel_leave_request — refusals\n");

  // 1. Cancelling somebody else's request must fail, for a non-admin role.
  {
    const other = await makeRequest(NEHA, 30);
    const { client } = await asUser(HR_EMAIL);
    const { error } = await client.rpc("cancel_leave_request", { p_request_id: other });
    check("HR cannot cancel another person's request", !!error, error?.message);
    const { data: still } = await A
      .from("leave_requests")
      .select("status")
      .eq("id", other)
      .single();
    check("  ...and it is still pending", still?.status === "pending");
  }

  // 2. A decided request cannot be cancelled.
  {
    const id = await makeRequest(NEHA, 31);
    await A.from("leave_requests")
      .update({ status: "rejected", decided_by: NEHA, decided_at: new Date().toISOString() })
      .eq("id", id);
    const { client } = await asUser(EMPLOYEE_EMAIL);
    const { error } = await client.rpc("cancel_leave_request", { p_request_id: id });
    check("a rejected request cannot be cancelled", !!error, error?.message);
  }

  // 3. Leave that has already started cannot be cancelled.
  {
    const id = await makeRequest(NEHA, -1);
    const { client } = await asUser(EMPLOYEE_EMAIL);
    const { error } = await client.rpc("cancel_leave_request", { p_request_id: id });
    check("leave that already started cannot be cancelled", !!error, error?.message);
  }

  console.log("\ncancel_leave_request — the happy path\n");

  // 4. The owner cancels their own future pending request, which really does have
  //    an approval chain and a live balance behind it.
  {
    const { id, client } = await makeRealRequest(EMPLOYEE_EMAIL, NEHA, 40);
    const balancesBefore = await balanceFingerprint(NEHA);

    const { data: stepsBefore } = await A
      .from("leave_approval_steps")
      .select("status")
      .eq("leave_request_id", id);
    check("the request has an approval chain to retire", (stepsBefore?.length ?? 0) > 0);

    const { data: canBefore } = await client.rpc("can_cancel_leave_request", {
      p_request_id: id,
    });
    check("can_cancel_leave_request is true beforehand", canBefore === true);

    const { data, error } = await client.rpc("cancel_leave_request", { p_request_id: id });
    check("owner cancels their own request", !error, error?.message);
    check("returns status cancelled", data?.status === "cancelled");

    const { data: after } = await A
      .from("leave_requests")
      .select("status, decided_by")
      .eq("id", id)
      .single();
    check("request is cancelled in the database", after?.status === "cancelled");
    check("decided_by is the requester", after?.decided_by === NEHA);

    // The chain is retired, not deleted.
    const { data: steps } = await A
      .from("leave_approval_steps")
      .select("status")
      .eq("leave_request_id", id);
    check(
      "pending steps are marked skipped, not deleted",
      (steps?.length ?? 0) > 0 && steps!.every((s) => s.status === "skipped"),
    );

    // Idempotency: a second attempt must refuse rather than double-apply.
    const { error: again } = await client.rpc("cancel_leave_request", { p_request_id: id });
    check("cancelling twice is refused", !!again, again?.message);

    const { data: canAfter } = await client.rpc("can_cancel_leave_request", {
      p_request_id: id,
    });
    check("can_cancel_leave_request is false afterwards", canAfter === false);

    // 5. Nothing is spent until final approval, so a cancel must leave the
    //    balance exactly as it was — no debit and no refund.
    check(
      "cancelling moves no balance at all",
      (await balanceFingerprint(NEHA)) === balancesBefore,
    );
  }

  // 6. Fixtures are cleaned up so verify:demo counts stay honest.
  {
    const { error } = await A
      .from("leave_requests")
      .delete()
      .eq("reason", "cancel verification fixture");
    check("fixtures removed", !error, error?.message);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
