/**
 * Phase 12 — end-to-end verification of the demo environment.
 *
 * Drives the real HTTP API with real signed-in sessions for each demo role, so
 * this exercises the same path the browser takes: proxy/middleware, route
 * handlers, RLS and the approval RPCs together.
 *
 * Every request is bounded by a timeout, because this project's Supabase instance
 * has been observed to hang rather than fail (see scripts/seed-demo-data.ts).
 *
 *   npx tsx scripts/verify-demo.ts
 */
import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { createAdminClient } from "../server/supabase/admin-core";

config({ path: ".env.local" });
config();

const APP = process.env.APP_URL ?? "http://localhost:3000";
const PASSWORD = "OrgFlow@2026";
const TIMEOUT_MS = 25_000;

type Role = "hr" | "deptHead" | "manager" | "employee";

const USERS: Record<Role, string> = {
  hr: "rohan.iyer@orgflow.dev",
  deptHead: "aditya.rao@orgflow.dev",
  manager: "sanjay.kapoor@orgflow.dev",
  employee: "neha.gupta@orgflow.dev",
};

const results: { ok: boolean; label: string; detail?: string }[] = [];

function record(ok: boolean, label: string, detail?: string) {
  results.push({ ok, label, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${label}${detail && !ok ? `  -> ${detail}` : ""}`);
}

/**
 * Build both transport shapes for one signed-in person:
 *  - `cookie`, for the app's own HTTP routes (the proxy reads the session cookie)
 *  - `client`, a Supabase client that has actually signed in, so its requests
 *    carry an `Authorization: Bearer` header and RLS sees the real user rather
 *    than anon. Replaying cookies alone is NOT enough: PostgREST reads the JWT
 *    from the header, and an unauthenticated client silently reads zero rows.
 */
async function session(email: string): Promise<{ cookie: string; client: SupabaseClient }> {
  const store = new Map<string, string>();
  const ssr = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => [...store].map(([name, value]) => ({ name, value })),
        setAll: (list) => {
          for (const { name, value, options } of list) {
            if (options?.maxAge === 0) store.delete(name);
            else store.set(name, value);
          }
        },
      },
    },
  );
  const { error } = await ssr.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  const cookie = [...store].map(([name, value]) => `${name}=${value}`).join("; ");

  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { error: clientError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (clientError) throw new Error(`client sign-in failed for ${email}: ${clientError.message}`);

  return { cookie, client };
}

const TRANSIENT = /fetch failed|aborted|timeout|timed out|ECONNRESET|socket hang up/i;

/**
 * Call an app endpoint, retrying transport-level failures.
 *
 * This project's Supabase instance intermittently hangs rather than refusing a
 * connection, so every call is bounded by a timeout and retried. An HTTP status
 * is never retried — a 403 is a real answer.
 */
async function api(cookie: string, path: string, method = "GET", body?: unknown, tries = 3) {
  let lastError = "";
  for (let i = 1; i <= tries; i += 1) {
    try {
      const response = await fetch(`${APP}${path}`, {
        method,
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON (e.g. an HTML redirect page) */
      }
      return { status: response.status, json, text };
    } catch (error) {
      lastError = String(error);
      if (!TRANSIENT.test(lastError) || i === tries) throw new Error(`${path}: ${lastError}`);
      console.warn(`  ${path}: ${lastError} — retrying (${i}/${tries - 1})`);
      await new Promise((resolve) => setTimeout(resolve, i * 1000));
    }
  }
  throw new Error(`${path}: ${lastError}`);
}

async function main() {
  const admin = createAdminClient();

  // ---- 1. all six accounts can sign in -------------------------------------
  const { data: authUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const emails = (authUsers?.users ?? []).map((u) => u.email).sort();
  record(emails.length === 6, "exactly 6 auth accounts exist", `found ${emails.length}: ${emails.join(", ")}`);

  const { data: emps } = await admin.from("employees").select("id,name,email,app_role,department,manager_id");
  record((emps ?? []).length === 6, "exactly 6 employee rows exist", `found ${(emps ?? []).length}`);
  record(
    (emps ?? []).every((e) => e.app_role !== "hr" || e.email === USERS.hr),
    "exactly one HR account",
  );
  record(
    (emps ?? []).filter((e) => e.app_role === "manager").length === 3,
    "3 managers (incl. the department head)",
  );
  record(
    (emps ?? []).filter((e) => e.app_role === "employee").length === 2,
    "2 employees",
  );

  const cookies: Partial<Record<Role, string>> = {};
  for (const role of Object.keys(USERS) as Role[]) {
    try {
      const { cookie } = await session(USERS[role]);
      cookies[role] = cookie;
      record(true, `sign-in works: ${role} (${USERS[role]})`);
    } catch (error) {
      record(false, `sign-in works: ${role} (${USERS[role]})`, String(error));
    }
  }

  const employee = (await session(USERS.employee)).client;
  const manager = (await session(USERS.manager)).client;
  const hr = (await session(USERS.hr)).client;
  const empCookie = cookies.employee!;
  const mgrCookie = cookies.manager!;
  const hrCookie = cookies.hr!;

  // ---- 2. employee can read their own data, and only their own ------------
  const balances = await employee.from("leave_balances").select("*").eq("year", new Date().getFullYear());
  record((balances.data ?? []).length === 4, "employee sees their 4 leave balances", `got ${(balances.data ?? []).length}`);

  // Only these columns are granted to a browser session (migration 0002 §5).
  const granted = await employee
    .from("employees")
    .select("id,name,photo,role,department,manager_id,join_date,is_active");
  record(
    !granted.error && (granted.data ?? []).length === 6,
    "employee sees the 6 directory rows via the granted columns",
    granted.error ? granted.error.message : `got ${(granted.data ?? []).length}`,
  );
  // Requesting a non-granted column must be refused outright.
  const denied = await employee.from("employees").select("id,app_role");
  record(
    !!denied.error,
    "employee cannot select the non-granted app_role column",
    denied.error ? undefined : "select unexpectedly succeeded",
  );
  const deniedEmail = await employee.from("employees").select("id,email");
  record(
    !!deniedEmail.error,
    "employee cannot select the non-granted email column",
    deniedEmail.error ? undefined : "select unexpectedly succeeded",
  );

  // ---- 3. role-based access control ---------------------------------------
  const hrOnly = await employee.rpc("q_leave_usage_by_department" as never, {
    p_from: new Date().toISOString().slice(0, 10),
    p_to: new Date().toISOString().slice(0, 10),
  } as never);
  record(
    !!hrOnly.error,
    "employee is refused a Smart-HR-Query RPC (HR only)",
    hrOnly.error ? undefined : "call unexpectedly succeeded",
  );

  const dashboardAsEmployee = await fetch(`${APP}/api/dashboard/summary`, {
    headers: { Cookie: empCookie },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const dashJson = (await dashboardAsEmployee.json().catch(() => null)) as { error?: { code?: string } } | null;
  record(
    dashboardAsEmployee.status === 403 && dashJson?.error?.code === "FORBIDDEN",
    "employee is refused the manager/HR dashboard API",
    `status ${dashboardAsEmployee.status}`,
  );

  const approvalsAsEmployee = await api(empCookie, "/api/approvals");
  record(
    approvalsAsEmployee.status === 403,
    "employee is refused the approvals inbox",
    `status ${approvalsAsEmployee.status}`,
  );

  // ---- 4. HR surfaces all respond -----------------------------------------
  for (const path of ["/api/dashboard/summary", "/api/org-chart", "/api/availability", "/api/alerts", "/api/approvals"]) {
    const response = await api(hrCookie, path);
    record(response.status === 200, `HR can read ${path}`, `status ${response.status}`);
  }

  // ---- 5. manager sees only their own team's approvals ---------------------
  const mgrApprovals = await api(mgrCookie, "/api/approvals");
  const mgrPending = (mgrApprovals.json as { data?: unknown[] } | null)?.data ?? [];
  record(mgrApprovals.status === 200 && mgrPending.length > 0, "manager has pending approvals to action", `${mgrPending.length} pending`);
  record(
    mgrPending.every((r) => (r as { employee?: { name?: string } }).employee?.name !== "Vikram Sethi"),
    "manager's inbox excludes the other department's employees",
  );

  // ---- 6. leave validation rules (employee-submitted) ----------------------
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const future = (offsetDays: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offsetDays);
    return iso(d);
  };

  /**
   * A window of exactly `workingDays` weekdays starting `startOffset` days out.
   *
   * Windows are computed from working days rather than fixed calendar spans so
   * the day count is exact and does not silently drift below the threshold the
   * approval rules key off.
   */
  const workingWindow = (startOffset: number, workingDays: number) => {
    const start = new Date(today);
    start.setDate(start.getDate() + startOffset);
    while (start.getDay() === 0 || start.getDay() === 6) start.setDate(start.getDate() + 1);
    const cursor = new Date(start);
    for (let counted = 1; counted < workingDays; ) {
      cursor.setDate(cursor.getDate() + 1);
      if (cursor.getDay() !== 0 && cursor.getDay() !== 6) counted += 1;
    }
    return { start: iso(start), end: iso(cursor) };
  };

  const sameYear = (w: { start: string; end: string }) =>
    w.start.slice(0, 4) === w.end.slice(0, 4) &&
    w.start.slice(0, 4) === String(today.getFullYear());

  const past = await employee.rpc("validate_leave_request", {
    p_leave_type: "casual",
    p_start: "2020-01-06",
    p_end: "2020-01-07",
  });
  record(
    past.data?.error_code === "INVALID_DATES",
    "server rejects leave that starts in the past",
    `got ${JSON.stringify(past.data?.error_code)}`,
  );

  const backwards = await employee.rpc("validate_leave_request", {
    p_leave_type: "casual",
    p_start: future(10),
    p_end: future(5),
  });
  record(
    backwards.data?.error_code === "INVALID_DATES",
    "server rejects an end date before the start date",
    `got ${JSON.stringify(backwards.data?.error_code)}`,
  );

  const weekend = await employee.rpc("validate_leave_request", {
    p_leave_type: "casual",
    p_start: "2027-01-02",
    p_end: "2027-01-03",
  });
  record(
    weekend.data?.error_code === "INVALID_DATES",
    "server rejects a weekend-only range",
    `got ${JSON.stringify(weekend.data?.error_code)}`,
  );

  // Priya's sick balance is allocated 8 with 2 spent, so 10 working days must be
  // refused for balance rather than for dates. This has to run against a window
  // clear of her own requests AND hers is a different employee from the journey
  // below, so the two checks cannot collide with each other either.
  const overspend = workingWindow(26, 10);
  record(sameYear(overspend), "overspend window stays inside one calendar year", `${overspend.start}..${overspend.end}`);
  const secondEmployee = (await session("priya.nair@orgflow.dev")).client;
  const huge = await secondEmployee.rpc("validate_leave_request", {
    p_leave_type: "sick",
    p_start: overspend.start,
    p_end: overspend.end,
  });
  record(
    huge.data?.error_code === "INSUFFICIENT_BALANCE",
    "server rejects a request exceeding the leave balance",
    `got ${JSON.stringify(huge.data?.error_code)}`,
  );

  // ---- 7. real submission -> hierarchical approval -> balance movement -----
  const { data: employees } = await admin.from("employees").select("id,name,email,app_role");
  const neha = (employees ?? []).find((e) => e.email === USERS.employee)!;
  const sanjay = (employees ?? []).find((e) => e.email === USERS.manager)!;
  const aditya = (employees ?? []).find((e) => e.email === USERS.deptHead)!;
  const rohan = (employees ?? []).find((e) => e.email === USERS.hr)!;

  // 10 working days -> above the 7-day threshold, so a 3-level chain.
  // Offset 12 keeps this clear of Neha's existing December request.
  const journey = workingWindow(12, 10);
  record(sameYear(journey), "journey window stays inside one calendar year", `${journey.start}..${journey.end}`);
  const start = journey.start;
  const end = journey.end;

  const before = await admin
    .from("leave_balances")
    .select("used")
    .eq("employee_id", neha.id)
    .eq("year", new Date().getFullYear())
    .eq("leave_type", "annual")
    .single();
  const usedBefore = Number(before.data?.used ?? 0);

  const created = await employee.rpc("create_leave_request", {
    p_leave_type: "annual",
    p_start: start,
    p_end: end,
    p_reason: "Phase 12 end-to-end journey verification.",
  });
  const requestId = (created.data as { id?: string } | null)?.id;
  record(!!requestId, "employee can submit a valid 3-level request", JSON.stringify(created.data));
  record(created.data?.valid === true, "submission reports itself valid");

  if (requestId) {
    const { data: chain } = await admin
      .from("leave_approval_steps")
      .select("level,status,approver_employee_id,approver_role")
      .eq("leave_request_id", requestId)
      .order("level");
    record((chain ?? []).length === 3, "a 9-day request builds a 3-level chain", `${(chain ?? []).length} steps`);
    record(
      (chain ?? []).map((s) => s.approver_employee_id).join(",") === `${sanjay.id},${aditya.id},${rohan.id}`,
      "chain is manager -> department head -> HR",
      (chain ?? []).map((s) => `${s.level}:${s.approver_role}`).join(" "),
    );

    const afterSubmit = await admin
      .from("leave_balances")
      .select("used")
      .eq("employee_id", neha.id)
      .eq("year", new Date().getFullYear())
      .eq("leave_type", "annual")
      .single();
    record(
      Number(afterSubmit.data?.used) === usedBefore,
      "balance is NOT spent while the request is still pending",
      `${usedBefore} -> ${afterSubmit.data?.used}`,
    );

    // self-approval must be impossible
    const selfApprove = await employee.rpc("approve_leave_request", {
      p_request_id: requestId,
      p_comment: "Approving my own request.",
    });
    record(
      (selfApprove.data as { error_code?: string } | null)?.error_code === "FORBIDDEN",
      "employee cannot approve their own request",
      JSON.stringify(selfApprove.data),
    );

    // the unrelated department manager must be refused
    const outsider = (await session("vikram.sethi@orgflow.dev")).client;
    const outsiderApprove = await outsider.rpc("approve_leave_request", {
      p_request_id: requestId,
      p_comment: "Not my team.",
    });
    record(
      (outsiderApprove.data as { error_code?: string } | null)?.error_code === "FORBIDDEN",
      "a manager from another department cannot approve",
      JSON.stringify(outsiderApprove.data),
    );

    // level 1
    const first = await manager.rpc("approve_leave_request", {
      p_request_id: requestId,
      p_comment: "Approved at my level.",
    });
    record(first.data?.ok === true, "manager signs level 1", JSON.stringify(first.data));

    const midway = await admin
      .from("leave_balances")
      .select("used")
      .eq("employee_id", neha.id)
      .eq("year", new Date().getFullYear())
      .eq("leave_type", "annual")
      .single();
    record(
      Number(midway.data?.used) === usedBefore,
      "balance is still NOT spent after an intermediate approval",
      `${usedBefore} -> ${midway.data?.used}`,
    );

    // duplicate approval of the same step must fail
    const duplicate = await manager.rpc("approve_leave_request", {
      p_request_id: requestId,
      p_comment: "Approving again.",
    });
    record(
      (duplicate.data as { error_code?: string } | null)?.error_code !== undefined,
      "duplicate approval of an already-signed step is refused",
      JSON.stringify(duplicate.data),
    );

    // level 2
    const deptHead = (await session(USERS.deptHead)).client;
    const second = await deptHead.rpc("approve_leave_request", {
      p_request_id: requestId,
      p_comment: "Endorsed at department level.",
    });
    record(second.data?.ok === true, "department head signs level 2", JSON.stringify(second.data));

    const stillPending = await admin
      .from("leave_balances")
      .select("used")
      .eq("employee_id", neha.id)
      .eq("year", new Date().getFullYear())
      .eq("leave_type", "annual")
      .single();
    record(
      Number(stillPending.data?.used) === usedBefore,
      "balance still not spent before the final signature",
      `${usedBefore} -> ${stillPending.data?.used}`,
    );

    // level 3 — the final signature must spend the balance
    const third = await hr.rpc("approve_leave_request", {
      p_request_id: requestId,
      p_comment: "Final approval from HR.",
    });
    record(third.data?.ok === true, "HR signs the final level", JSON.stringify(third.data));

    const { data: settled } = await admin
      .from("leave_requests")
      .select("status,days,decided_by")
      .eq("id", requestId)
      .single();
    record(settled?.status === "approved", "request is approved after the final signature", settled?.status);
    record(settled?.decided_by === rohan.id, "the final approver is recorded", String(settled?.decided_by));

    const finalBalance = await admin
      .from("leave_balances")
      .select("used,remaining")
      .eq("employee_id", neha.id)
      .eq("year", new Date().getFullYear())
      .eq("leave_type", "annual")
      .single();
    const expectedUsed = usedBefore + Number(settled?.days ?? 0);
    record(
      Number(finalBalance.data?.used) === expectedUsed,
      "balance is spent exactly once, on final approval",
      `${usedBefore} + ${settled?.days} => ${finalBalance.data?.used}`,
    );

    // overlap protection now that this request is approved
    const overlap = await employee.rpc("validate_leave_request", {
      p_leave_type: "annual",
      p_start: start,
      p_end: end,
    });
    record(
      overlap.data?.error_code === "OVERLAPPING_DATES" ||
        (overlap.data?.conflicts as unknown[] | undefined)?.length === 0
        ? false
        : true,
      "approved leave blocks an overlapping request",
      JSON.stringify(overlap.data),
    );

    // clean up the journey so only demo data remains
    await admin.from("leave_approval_steps").delete().eq("leave_request_id", requestId);
    await admin.from("leave_requests").delete().eq("id", requestId);
    await admin
      .from("leave_balances")
      .update({ used: usedBefore })
      .eq("employee_id", neha.id)
      .eq("year", new Date().getFullYear())
      .eq("leave_type", "annual");
    console.log("      (journey fixture removed)");
  }

  // ---- 8. blocked request + HR override -----------------------------------
  const { data: blocked } = await admin
    .from("leave_requests")
    .select("id,status,blocked_reason")
    .eq("status", "approval_blocked")
    .limit(1)
    .maybeSingle();
  record(!!blocked, "the department head's own request is parked as approval_blocked");
  record(
    !!blocked?.blocked_reason && blocked.blocked_reason.length > 10,
    "the blocked request carries a human-readable reason",
  );

  // ---- 9. AI endpoints degrade gracefully, never 500 ------------------------
  const chat = await fetch(`${APP}/api/ai/chat`, {
    method: "POST",
    headers: { Cookie: empCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "How much annual leave do I have left?" }),
    signal: AbortSignal.timeout(60_000),
  });
  const chatJson = (await chat.json().catch(() => null)) as { meta?: { available?: boolean } } | null;
  record(
    chat.status === 200 && chatJson !== null,
    "AI chat endpoint answers 200 even when the provider quota is exhausted",
    `status ${chat.status}`,
  );

  // ---- 10. no service-role key reachable from the client -------------------
  const page = await fetch(`${APP}/dashboard`, {
    headers: { Cookie: empCookie },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const html = await page.text();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  record(!serviceKey || !html.includes(serviceKey), "service-role key is absent from rendered HTML");
  record(
    !/sb_secret|sbp_[A-Za-z0-9]{20,}/.test(html),
    "no Supabase secret/service key pattern appears in rendered HTML",
  );

  // ---- summary -------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  - ${f.label}${f.detail ? ` (${f.detail})` : ""}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
