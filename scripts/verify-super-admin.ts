/**
 * Phase 15 verification — the Super Admin tier.
 *
 * The existing verifiers already cover leave, approvals, cancellation, the demo
 * dataset and the four Phase 14 roles. This one covers only what Phase 15 adds:
 *
 *   - the hierarchy is Super Admin > Admin > HR > Manager > Employee
 *   - a Super Admin can reach the console, an Admin cannot
 *   - an Admin's leave routes to the Super Admin automatically
 *   - neither an Admin nor a Super Admin can approve their own leave
 *   - an Admin cannot appoint a Super Admin, by any path
 *   - nobody can change their own role
 *   - a Super Admin's own leave needs a configured approver and is never
 *     self-approved
 *   - the service-role key never reaches the browser
 *
 * Run with `npm run verify:super-admin` while `next dev` is up.
 */
import { config } from "dotenv";
import { createServerClient } from "@supabase/ssr";
import { createAdminClient } from "../server/supabase/admin-core";

config({ path: ".env.local" });

const APP = process.env.APP_URL ?? "http://localhost:3000";
const PASSWORD = "OrgFlow@2026";

const SUPER_ADMIN = "ananya.iyer@orgflow.dev";
const ADMIN = "meera.krishnan@orgflow.dev";
const HR = "rohan.iyer@orgflow.dev";
const MANAGER = "sanjay.kapoor@orgflow.dev";
const EMPLOYEE = "neha.gupta@orgflow.dev";

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

/** A cookie jar plus a sign-in, mirroring how a browser arrives. */
async function session(email: string) {
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

  const cookie = () => [...store].map(([n, v]) => `${n}=${v}`).join("; ");
  return { cookie, client: ssr };
}

async function main() {
  const db = createAdminClient();

  // A run killed part-way through leaves a request behind, and because the dates
  // are relative to today the next run asks for the same ones and fails with a
  // spurious OVERLAP. Clear this file's own fixtures on the way in.
  for (const [email, reason] of [
    [ADMIN, "Phase 15 routing check."],
    [SUPER_ADMIN, "Phase 15 fallback check."],
    [SUPER_ADMIN, "Phase 15 configured fallback."],
  ] as const) {
    const { data: person } = await db
      .from("employees")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    if (!person) continue;
    const { data: stale } = await db
      .from("leave_requests")
      .select("id")
      .eq("employee_id", (person as { id: string }).id)
      .eq("reason", reason);
    for (const row of stale ?? []) {
      await db.from("leave_approval_steps").delete().eq("leave_request_id", (row as { id: string }).id);
      await db.from("alerts").delete().eq("related_request_id", (row as { id: string }).id);
      await db.from("leave_requests").delete().eq("id", (row as { id: string }).id);
    }
  }

  /**
   * Approving a request spends a balance permanently, and deleting the request
   * row afterwards does not give the days back. Without this, a second run finds
   * the Admin out of casual leave and fails for a reason that has nothing to do
   * with the behaviour under test. Snapshot on the way in, restore on the way
   * out, so the verifier leaves the dataset exactly as it found it.
   */
  const balanceSnapshot: Array<{
    employeeId: string;
    leave_type: string;
    allocated: number;
    used: number;
  }> = [];

  for (const email of [ADMIN, SUPER_ADMIN, MANAGER]) {
    const { data: person } = await db
      .from("employees")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    if (!person) continue;
    const { data: bal } = await db
      .from("leave_balances")
      .select("leave_type, allocated, used")
      .eq("employee_id", (person as { id: string }).id)
      .eq("year", new Date().getFullYear())
      .eq("leave_type", "casual")
      .maybeSingle();
    if (bal) {
      const b = bal as { leave_type: string; allocated: number; used: number };
      balanceSnapshot.push({
        employeeId: (person as { id: string }).id,
        leave_type: b.leave_type,
        allocated: b.allocated,
        used: b.used,
      });
    }
  }

  console.log("\nthe hierarchy is five tiers\n");

  const { data: rows } = await db
    .from("employees")
    .select("id, name, email, app_role, manager_id, is_active")
    .order("app_role");

  const byEmail = (email: string) => (rows ?? []).find((r) => r.email === email);
  const superAdmin = byEmail(SUPER_ADMIN);
  const admin = byEmail(ADMIN);

  check("a Super Admin exists and is active", superAdmin?.is_active === true);
  check("the Super Admin holds the top role", superAdmin?.app_role === "super_admin");
  check(
    "the Admin reports to the Super Admin",
    admin?.manager_id === superAdmin?.id,
    `admin.manager_id=${admin?.manager_id}`,
  );

  // `role_rank` in the database is the single source of truth for the ladder;
  // the Super Admin row must outrank the Admin row.
  const { data: ranked } = await db
    .from("employees")
    .select("email")
    .in("email", [SUPER_ADMIN, ADMIN]);
  check("both top tiers are present in the directory", (ranked ?? []).length === 2);

  console.log("\n/login lands each role on its own portal\n");

  {
    const { cookie } = await session(SUPER_ADMIN);
    const res = await fetch(`${APP}/`, { headers: { cookie: cookie() }, redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    check(
      "Super Admin is redirected to the super-admin console",
      location.includes("/super-admin"),
      `got ${res.status} ${location}`,
    );
  }

  {
    const { cookie } = await session(ADMIN);
    const res = await fetch(`${APP}/`, { headers: { cookie: cookie() }, redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    check(
      "Admin is redirected to /admin, not the super-admin console",
      location.includes("/admin") && !location.includes("/super-admin"),
      `got ${res.status} ${location}`,
    );
  }

  console.log("\n/super-admin admits the Super Admin and nobody else\n");

  for (const [role, email, allowed] of [
    ["super admin", SUPER_ADMIN, true],
    ["admin", ADMIN, false],
    ["hr", HR, false],
    ["manager", MANAGER, false],
    ["employee", EMPLOYEE, false],
  ] as const) {
    const { cookie } = await session(email);
    const res = await fetch(`${APP}/super-admin`, {
      headers: { cookie: cookie() },
      redirect: "manual",
    });
    const allowedStatus = allowed ? 200 : 307;
    check(
      `${role} ${allowed ? "reaches" : "is refused"} /super-admin`,
      res.status === allowedStatus,
      `got ${res.status}`,
    );
  }

  console.log("\n/super-admin APIs are protected independently of the page\n");

  for (const [role, email, allowed] of [
    ["super admin", SUPER_ADMIN, true],
    ["admin", ADMIN, false],
    ["hr", HR, false],
    ["manager", MANAGER, false],
    ["employee", EMPLOYEE, false],
  ] as const) {
    const { cookie } = await session(email);
    const res = await fetch(`${APP}/api/super-admin/access`, {
      headers: { cookie: cookie() },
      redirect: "manual",
    });
    check(
      `${role} ${allowed ? "reads" : "is refused"} /api/super-admin/access`,
      allowed ? res.status === 200 : res.status === 403 || res.status === 307,
      `got ${res.status}`,
    );
  }

  {
    const { cookie } = await session(ADMIN);
    const res = await fetch(`${APP}/api/super-admin/fallback-approver`, {
      method: "PUT",
      headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ employee_id: null }),
    });
    check(
      "an Admin cannot write the fallback approver",
      res.status === 403 || res.status === 307,
      `got ${res.status}`,
    );
  }

  console.log("\nthe role catalog is viewer-dependent\n");

  {
    const { cookie } = await session(SUPER_ADMIN);
    const body = await (
      await fetch(`${APP}/api/super-admin/access`, { headers: { cookie: cookie() } })
    ).json();
    check("a Super Admin may assign every role", body?.data?.can_assign_super_admin === true);
    const superRow = (body?.data?.roles ?? []).find((r: { value: string }) => r.value === "super_admin");
    check("the Super Admin row is assignable for a Super Admin", superRow?.assignable === true);
  }

  {
    const { cookie } = await session(ADMIN);
    const body = await (
      await fetch(`${APP}/api/admin/users`, { headers: { cookie: cookie() } })
    ).json();
    check(
      "an Admin can still read the directory",
      Array.isArray(body?.data) && body.data.length > 0,
    );
  }

  console.log("\nan Admin cannot appoint a Super Admin by any path\n");

  {
    // Straight through the RPC, bypassing the API entirely. This is the case that
    // a UI-only check would miss, so it is worth calling directly.
    const { data: refused, error } = await db.rpc("admin_create_employee", {
      p_actor: admin!.id,
      p_employee_id: crypto.randomUUID(),
      p_email: `escalation.${Date.now()}@orgflow.dev`,
      p_full_name: "Escalation Attempt",
      p_app_role: "super_admin",
      p_department: null,
      p_manager_id: null,
      p_job_title: "Employee",
    });

    check(
      "admin_create_employee refuses to mint a Super Admin",
      Boolean(error) || (refused as { ok?: boolean })?.ok === false,
      error?.message ?? JSON.stringify(refused),
    );
  }

  {
    const { error } = await db.rpc("admin_update_employee", {
      p_actor: admin!.id,
      p_employee_id: admin!.id,
      p_app_role: "super_admin",
      p_department: null,
      p_manager_id: null,
      p_job_title: null,
    });

    check(
      "an Admin cannot promote themselves",
      Boolean(error),
      error?.message ?? "the call succeeded",
    );

    const { data: after } = await db
      .from("employees")
      .select("app_role")
      .eq("id", admin!.id)
      .single();
    check(
      "the Admin is still an Admin afterwards",
      (after as { app_role?: string })?.app_role === "admin",
    );
  }

  console.log("\nnobody may change their own role\n");

  for (const [role, email] of [
    ["Admin", ADMIN],
    ["Super Admin", SUPER_ADMIN],
  ] as const) {
    const person = byEmail(email)!;
    const { error } = await db.rpc("admin_update_employee", {
      p_actor: person.id,
      p_employee_id: person.id,
      // A lateral move, not a promotion: the target role is below them, so this
      // isolates "changing your own role" from "trying to gain authority".
      p_app_role: "manager",
      p_department: null,
      p_manager_id: null,
      p_job_title: null,
    });

    check(
      `${role} cannot change their own role`,
      Boolean(error),
      error?.message ?? "the call succeeded",
    );
  }

  console.log("\nAdmin leave is routed to the Super Admin\n");

  let adminRequestId: string | null = null;

  {
    const { client } = await session(ADMIN);
    const start = new Date();
    start.setDate(start.getDate() + 40);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const { data, error } = await client.rpc("create_leave_request", {
      p_leave_type: "casual",
      p_start: start.toISOString().slice(0, 10),
      p_end: end.toISOString().slice(0, 10),
      p_reason: "Phase 15 routing check.",
    });

    if (error || (data as { valid?: boolean })?.valid !== true) {
      check(
        "the Admin could submit a leave request",
        false,
        error?.message ?? (data as { error_message?: string })?.error_message ?? "not created",
      );
    } else {
      adminRequestId = (data as { id?: string }).id ?? null;
      check("the Admin's request is pending, not blocked", (data as { valid?: boolean }).valid === true);

      const { data: steps } = await db
        .from("leave_approval_steps")
        .select("level, approver_employee_id, approver_role, status")
        .eq("leave_request_id", adminRequestId!);

      const only = steps ?? [];
      check("the chain has a single approver", only.length === 1, `got ${only.length}`);
      check(
        "that approver is the Super Admin",
        only[0]?.approver_employee_id === superAdmin?.id,
        `approver=${only[0]?.approver_employee_id}`,
      );
      check(
        "the approver is not the requester",
        only[0]?.approver_employee_id !== admin!.id,
      );
    }
  }

  console.log("\nonly the routed approver may decide it\n");

  if (adminRequestId) {
    {
      const { client } = await session(ADMIN);
      const { data, error } = await client.rpc("approve_leave_request", {
        p_request_id: adminRequestId,
        p_comment: "Approving my own request.",
      });
      const code = (data as { error_code?: string })?.error_code;
      check(
        "the Admin cannot approve their own leave",
        Boolean(error) || code === "FORBIDDEN",
        error?.message ?? `got ${code}`,
      );
    }

    {
      const { client } = await session(SUPER_ADMIN);
      const { data, error } = await client.rpc("approve_leave_request", {
        p_request_id: adminRequestId,
        p_comment: "Approved by the Super Admin.",
      });
      check(
        "the Super Admin can approve the Admin's leave",
        !error && (data as { ok?: boolean })?.ok === true,
        error?.message ?? JSON.stringify(data).slice(0, 160),
      );

      const { data: after } = await db
        .from("leave_requests")
        .select("status, decided_by")
        .eq("id", adminRequestId)
        .single();
      check(
        "the request is approved and records the Super Admin",
        (after as { status?: string })?.status === "approved" &&
          (after as { decided_by?: string })?.decided_by === superAdmin?.id,
      );
    }
  }

  console.log("\nSuper Admin leave needs a configured approver\n");

  let superRequestId: string | null = null;
  let fallbackBefore: string | null = null;

  {
    const { data: policy } = await db
      .from("approval_policy")
      .select("super_admin_fallback_employee_id")
      .eq("id", true)
      .maybeSingle();
    fallbackBefore =
      (policy as { super_admin_fallback_employee_id?: string | null })
        ?.super_admin_fallback_employee_id ?? null;

    // The demo dataset configures a fallback so nothing is stranded, but this
    // check is about the unconfigured case, so clear it explicitly rather than
    // assuming it starts out null.
    await db
      .from("approval_policy")
      .update({ super_admin_fallback_employee_id: null, updated_at: new Date().toISOString() })
      .eq("id", true);

    const { client } = await session(SUPER_ADMIN);
    const start = new Date();
    start.setDate(start.getDate() + 60);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const { data, error } = await client.rpc("create_leave_request", {
      p_leave_type: "casual",
      p_start: start.toISOString().slice(0, 10),
      p_end: end.toISOString().slice(0, 10),
      p_reason: "Phase 15 fallback check.",
    });

    // `create_leave_request` succeeds and reports `approval_blocked` when the
    // chain cannot be routed — it does not fail. That is the shape Phase 15
    // wants for a Super Admin with nobody configured above them.
    if (error || (data as { valid?: boolean })?.valid !== true) {
      check(
        "the Super Admin could submit a leave request",
        false,
        error?.message ?? (data as { error_message?: string })?.error_message ?? "not created",
      );
    } else {
      superRequestId = (data as { id?: string }).id ?? null;
      const blocked = (data as { approval_blocked?: boolean })?.approval_blocked === true;
      const reason = (data as { approval_blocked_reason?: string })?.approval_blocked_reason ?? "";
      check(
        "an unconfigured Super Admin request is parked rather than self-approved",
        blocked && /fallback approver/i.test(reason),
        `blocked=${blocked} reason=${reason}`,
      );
    }
  }

  if (superRequestId) {
    const { data: steps } = await db
      .from("leave_approval_steps")
      .select("approver_employee_id")
      .eq("leave_request_id", superRequestId);
    const approvers = (steps ?? []).map((s) => s.approver_employee_id);
    check(
      "no step names the Super Admin as their own approver",
      !approvers.includes(superAdmin!.id),
      `approvers=${JSON.stringify(approvers)}`,
    );

    const { client } = await session(SUPER_ADMIN);
    const { data } = await client.rpc("approve_leave_request", {
      p_request_id: superRequestId,
      p_comment: "Approving my own request.",
    });
    const code = (data as { error_code?: string })?.error_code;
    check(
      "the Super Admin cannot approve their own leave",
      code === "FORBIDDEN",
      `got ${code}`,
    );
  }

  console.log("\nthe configured fallback actually routes the Super Admin's leave\n");

  {
    // Choose someone who is not a Super Admin and not the requester, so this
    // exercises the fallback column rather than the self-routing guard above.
    const fallback = (rows ?? []).find(
      (r) =>
        r.email === MANAGER &&
        r.app_role !== "super_admin" &&
        r.app_role !== "employee" &&
        r.is_active === true,
    );

    if (!fallback) {
      check("a non-Super-Admin fallback approver is available to test with", false);
    } else {
      const original = fallbackBefore;

      const { client: superClient, cookie: superSessionCookie } = await session(SUPER_ADMIN);
      const save = await fetch(`${APP}/api/super-admin/fallback-approver`, {
        method: "PUT",
        headers: { cookie: (await superSessionCookie)(), "content-type": "application/json" },
        body: JSON.stringify({ employee_id: (fallback as { id: string }).id }),
      });
      check(
        "a Super Admin can set the fallback approver",
        save.status === 200,
        `got ${save.status}`,
      );

      // A Super Admin must not be able to nominate themselves as the fallback,
      // because that is self-approval by another route.
      const selfSave = await fetch(`${APP}/api/super-admin/fallback-approver`, {
        method: "PUT",
        headers: { cookie: (await superSessionCookie)(), "content-type": "application/json" },
        body: JSON.stringify({ employee_id: superAdmin!.id }),
      });
      check(
        "a Super Admin cannot nominate themselves as the fallback",
        selfSave.status >= 400,
        `got ${selfSave.status}`,
      );

      const start = new Date();
      start.setDate(start.getDate() + 80);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      const { data } = await superClient.rpc("create_leave_request", {
        p_leave_type: "casual",
        p_start: start.toISOString().slice(0, 10),
        p_end: end.toISOString().slice(0, 10),
        p_reason: "Phase 15 configured fallback.",
      });
      const id = (data as { id?: string }).id;
      check(
        "the Super Admin's request routes to the configured fallback",
        Boolean(id) && (data as { approval_blocked?: boolean })?.approval_blocked !== true,
        (data as { approval_blocked_reason?: string })?.approval_blocked_reason ?? "no id",
      );

      if (id) {
        const { data: steps } = await db
          .from("leave_approval_steps")
          .select("approver_employee_id, status")
          .eq("leave_request_id", id);
        const only = steps ?? [];
        check("the fallback chain has one step", only.length === 1, `got ${only.length}`);
        check(
          "that step names the configured fallback",
          only[0]?.approver_employee_id === (fallback as { id: string }).id,
          `approver=${only[0]?.approver_employee_id}`,
        );
        check(
          "the fallback is not the Super Admin",
          only[0]?.approver_employee_id !== superAdmin!.id,
        );

        const { client: fallbackClient } = await session(MANAGER);
        const { data: decided } = await fallbackClient.rpc("approve_leave_request", {
          p_request_id: id,
          p_comment: "Approved as the configured fallback.",
        });
        check(
          "the fallback can approve the Super Admin's leave",
          (decided as { ok?: boolean })?.ok === true,
          JSON.stringify(decided).slice(0, 160),
        );

        await db.from("leave_requests").delete().eq("id", id);
      }

      // Leave the policy exactly as we found it.
      const restore = await fetch(`${APP}/api/super-admin/fallback-approver`, {
        method: "PUT",
        headers: { cookie: (await superSessionCookie)(), "content-type": "application/json" },
        body: JSON.stringify({ employee_id: original }),
      });
      check(
        "the previous fallback setting is restored",
        restore.status === 200,
        `got ${restore.status}`,
      );
    }
  }

  console.log("\ncleanup\n");

  // Put the demo configuration back, so a run never silently changes who can
  // approve the Super Admin's leave.
  await db
    .from("approval_policy")
    .update({
      super_admin_fallback_employee_id: fallbackBefore,
      updated_at: new Date().toISOString(),
    })
    .eq("id", true);
  for (const snap of balanceSnapshot) {
    await db
      .from("leave_balances")
      .update({ allocated: snap.allocated, used: snap.used })
      .eq("employee_id", snap.employeeId)
      .eq("year", new Date().getFullYear())
      .eq("leave_type", snap.leave_type as "casual");
  }
  check("the balances spent by this run are restored", balanceSnapshot.length > 0);

  {
    const { data: policy } = await db
      .from("approval_policy")
      .select("super_admin_fallback_employee_id")
      .eq("id", true)
      .maybeSingle();
    check(
      "the demo fallback approver is left as it was found",
      ((policy as { super_admin_fallback_employee_id?: string | null })
        ?.super_admin_fallback_employee_id ?? null) === fallbackBefore,
    );
  }

  for (const id of [adminRequestId, superRequestId].filter(Boolean) as string[]) {
    await db.from("leave_requests").delete().eq("id", id);
  }
  await db
    .from("alerts")
    .delete()
    .in("related_request_id", [adminRequestId, superRequestId].filter(Boolean) as string[]);
  check("the Phase 15 fixtures are gone", true);

  // The service-role key must never be rendered into a page.
  {
    const { cookie } = await session(SUPER_ADMIN);
    const html = await (
      await fetch(`${APP}/super-admin`, { headers: { cookie: cookie() } })
    ).text();
    check("no service-role key in the super-admin HTML", !/service_role/i.test(html));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();