/**
 * Phase 14 four-role verification.
 *
 * Checks the claims the phase actually makes about the four tiers, over real HTTP
 * with real session cookies rather than by calling the database directly:
 *
 *   1. Each role lands on its own dashboard after signing in.
 *   2. `?next=` cannot steer somebody into a portal above their own tier.
 *   3. Every `/api/admin/*` route refuses the three lower roles.
 *   4. An administrator reaches the admin surfaces the nav offers.
 *   5. Signing out actually ends the session.
 *
 * Run: npm run verify:roles
 */
import { config } from "dotenv";
import { createServerClient } from "@supabase/ssr";
import { canRoleVisit, navForRole, homeForRole } from "../shared/nav";
import type { AppRole } from "../shared/types";

config({ path: ".env.local" });
config();

const APP = process.env.APP_URL ?? "http://localhost:3000";
const PASSWORD = "OrgFlow@2026";

const ACCOUNTS: Record<AppRole, string> = {
  employee: "neha.gupta@orgflow.dev",
  manager: "sanjay.kapoor@orgflow.dev",
  hr: "rohan.iyer@orgflow.dev",
  admin: "meera.krishnan@orgflow.dev",
  super_admin: "ananya.iyer@orgflow.dev",
};

/** Routes only the administrator tier may reach. */
const ADMIN_ROUTES = [
  "/admin",
  "/admin/users",
  "/admin/departments",
  "/admin/approval-hierarchy",
  "/admin/activity",
];

/**
 * Admin-only JSON endpoints, with a request that is otherwise well formed.
 *
 * `id` is filled in at run time with a disposable person, so these checks prove
 * the write path works without mutating the demo dataset. An earlier version
 * pointed the PATCH at a real employee and left them an inactive administrator.
 */
const ADMIN_API: { path: string; method: string; body?: unknown; mutates?: boolean }[] = [
  { path: "/api/admin/users", method: "GET" },
  { path: "/api/admin/activity", method: "GET" },
  { path: "/api/admin/departments", method: "GET" },
  { path: "/api/admin/approval-policy", method: "GET" },
  {
    path: "/api/admin/users",
    method: "POST",
    mutates: true,
    body: {
      full_name: "Disposable Verifier",
      email: "disposable.verifier@orgflow.dev",
      password: "OrgFlow@2026",
      app_role: "employee",
    },
  },
  { path: "/api/admin/users/__SCRATCH__", method: "PATCH", mutates: true, body: { job_title: "Verifier" } },
  {
    path: "/api/admin/users/__SCRATCH__/active",
    method: "POST",
    mutates: true,
    body: { is_active: false },
  },
];

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

/** A cookie jar plus the sign-in form post, mirroring how a browser arrives. */
async function signedInSession(email: string) {
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

  // `signOut` is a server action, which a plain fetch cannot invoke, so this
  // performs the same call the action makes. Both go through the Supabase SSR
  // client, which is what clears the session cookies.
  const signOut = async () => {
    await ssr.auth.signOut();
  };

  return { cookie, signOut };
}

async function main() {
  // ---- 1. each role has its own landing page -------------------------------
  console.log("\nlanding pages\n");
  for (const role of Object.keys(ACCOUNTS) as AppRole[]) {
    const { cookie } = await signedInSession(ACCOUNTS[role]);
    const res = await fetch(`${APP}${homeForRole(role)}`, {
      headers: { cookie: cookie() },
      redirect: "manual",
    });
    check(`${role} reaches ${homeForRole(role)}`, res.status === 200, `got ${res.status}`);
  }

  // ---- 2. `?next=` cannot climb above the caller's tier --------------------
  //
  // The decision functions are asserted directly, because they *are* the rule
  // `signIn` applies: it picks `homeForRole(role)` unless `canRoleVisit` allows
  // the requested path. Invoking the server action itself needs a Next action id
  // and would test the framework as much as the logic.
  console.log("\n?next= cannot cross role tiers\n");

  check("an employee's home is /dashboard", homeForRole("employee") === "/dashboard");
  check("a manager's home is /dashboard", homeForRole("manager") === "/dashboard");
  check("HR's home is /hr-dashboard", homeForRole("hr") === "/hr-dashboard");
  check("an admin's home is /admin", homeForRole("admin") === "/admin");
  check("a super admin's home is /super-admin", homeForRole("super_admin") === "/super-admin");

  check("an employee may visit their own dashboard", canRoleVisit("employee", "/dashboard"));
  check(
    "an employee may not visit /admin",
    !canRoleVisit("employee", "/admin"),
  );
  check("an employee may not visit /admin/users", !canRoleVisit("employee", "/admin/users"));
  check("a manager may not visit /hr-dashboard", !canRoleVisit("manager", "/hr-dashboard"));
  check("HR may visit /hr-dashboard", canRoleVisit("hr", "/hr-dashboard"));
  check("an admin may visit /admin/users", canRoleVisit("admin", "/admin/users"));
  check("an admin may not visit an arbitrary path", !canRoleVisit("admin", "/not-a-route"));
  check(
    "an off-site target is never treated as local",
    !canRoleVisit("admin", "https://example.com/admin"),
  );

  // Phase 15: the top role sits above Admin and is admitted everywhere Admin is,
  // plus its own console. An Admin must still be kept out of that console.
  check("a super admin may visit /super-admin", canRoleVisit("super_admin", "/super-admin"));
  check("a super admin may visit /admin", canRoleVisit("super_admin", "/admin"));
  check("a super admin may visit /admin/users", canRoleVisit("super_admin", "/admin/users"));
  check(
    "a super admin may still not visit an arbitrary path",
    !canRoleVisit("super_admin", "/not-a-route"),
  );
  check(
    "an admin may not visit /super-admin",
    !canRoleVisit("admin", "/super-admin"),
  );
  check("HR may not visit /super-admin", !canRoleVisit("hr", "/super-admin"));

  for (const role of Object.keys(ACCOUNTS) as AppRole[]) {
    const { cookie } = await signedInSession(ACCOUNTS[role]);
    const reachable = new Set(navForRole(role).map((item) => item.href));

    for (const target of ADMIN_ROUTES) {
      // `canRoleVisit` is the rule the action applies; assert the rule, then the
      // behaviour, because the behaviour alone would not say *why*.
      const permitted = reachable.has(target);
      // Phase 15 puts the Super Admin above Admin with full access to the admin
      // tier, so both are expected to be admitted here.
      if (role === "admin" || role === "super_admin") {
        check(`${role} may visit ${target}`, permitted);
        continue;
      }
      check(`${role} may not visit ${target}`, !permitted);

      // Reaching it by URL must still be refused by the page guard.
      const res = await fetch(`${APP}${target}`, { headers: { cookie: cookie() }, redirect: "manual" });
      const location = res.headers.get("location") ?? "";
      check(
        `${role} GET ${target} is redirected away`,
        res.status >= 300 && res.status < 400,
        `got ${res.status}`,
      );
      void location;
    }
  }

  // ---- 3. the admin API refuses every lower role ---------------------------
  //
  // The scratch person is created first, so each refusal below is tested with a
  // request an administrator would genuinely be allowed to make. Without that, a
  // 403 could just mean the payload was invalid.
  console.log("\n/api/admin/* refuses non-admins\n");

  const scratchEmail = `verify.scratch.${Date.now()}@orgflow.dev`;
  const createRes = await fetch(`${APP}/api/admin/users`, {
    method: "POST",
    headers: {
      cookie: (await signedInSession(ACCOUNTS.admin)).cookie(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      full_name: "Disposable Verifier",
      email: scratchEmail,
      password: "OrgFlow@2026",
      app_role: "employee",
    }),
  });
  const created = await createRes.json();
  const SCRATCH = { id: created?.data?.id ?? "" };
  check("a disposable person can be created for the write checks", createRes.status === 201 && !!SCRATCH.id,
    `got ${createRes.status}`);

  for (const role of ["employee", "manager", "hr"] as AppRole[]) {
    const { cookie } = await signedInSession(ACCOUNTS[role]);
    for (const call of ADMIN_API) {
      if (call.mutates && call.method === "POST" && call.path === "/api/admin/users") {
        // Creating is covered by the 403 below too, but with a throwaway address
        // so a failure cannot leave a real person behind.
        const res = await fetch(`${APP}${call.path}`, {
          method: call.method,
          headers: { cookie: cookie(), "content-type": "application/json" },
          body: JSON.stringify({ ...(call.body as object), email: scratchEmail }),
          redirect: "manual",
        });
        check(`${role} ${call.method} ${call.path} -> 403`, res.status === 403, `got ${res.status}`);
        continue;
      }

      const path = call.path.replace("__SCRATCH__", SCRATCH.id);
      const res = await fetch(`${APP}${path}`, {
        method: call.method,
        headers: { cookie: cookie(), "content-type": "application/json" },
        body: call.body ? JSON.stringify(call.body) : undefined,
        redirect: "manual",
      });
      check(
        `${role} ${call.method} ${call.path.replace("__SCRATCH__", "scratch")} -> 403`,
        res.status === 403,
        `got ${res.status}`,
      );
    }
  }

  // ---- 4. the admin API admits the administrator ---------------------------
  console.log("\n/api/admin/* admits the administrator\n");
  {
    const { cookie } = await signedInSession(ACCOUNTS.admin);

    for (const call of ADMIN_API) {
      // Creating the disposable person already happened, and a second POST would
      // collide on the email. Every other call still has to run here.
      if (call.method === "POST" && call.path === "/api/admin/users") continue;

      const res = await fetch(`${APP}${call.path.replace("__SCRATCH__", SCRATCH.id)}`, {
        method: call.method,
        headers: { cookie: cookie(), "content-type": "application/json" },
        body: call.body ? JSON.stringify(call.body) : undefined,
        redirect: "manual",
      });
      check(
        `admin ${call.method} ${call.path.replace("__SCRATCH__", "scratch")} -> 200`,
        res.status === 200,
        `got ${res.status}`,
      );
    }

    // Changing the scratch person's role and access took effect.
    const listed = await (await fetch(`${APP}/api/admin/users`, { headers: { cookie: cookie() } })).json();
    const row = (listed?.data ?? []).find((r: { id: string }) => r.id === SCRATCH.id);
    check("a new person appears in the directory", !!row);
    check("a role change is persisted", row?.role === "Verifier", `role=${row?.role}`);
    check("deactivation is persisted", row?.is_active === false, `active=${row?.is_active}`);

    // The full directory is readable, including the columns an ordinary employee
    // session may not select.
    const rows = listed?.data ?? [];
    check("admin sees every person", rows.length >= 8, `got ${rows.length}`);
    check(
      "admin sees the restricted columns",
      rows.length > 0 && rows.every((r: Record<string, unknown>) => !!r.email && !!r.app_role),
    );
  }

  // ---- 5. signing out ends the session ------------------------------------
  console.log("\nsign out\n");
  {
    const { cookie, signOut } = await signedInSession(ACCOUNTS.admin);

    const before = await fetch(`${APP}/api/admin/users`, { headers: { cookie: cookie() } });
    check("session works before sign-out", before.status === 200, `got ${before.status}`);

    await signOut();

    // The same jar the browser would hold afterwards no longer carries a session:
    // the route either refuses outright or bounces to the login page. What matters
    // is that it never serves admin data.
    const after = await fetch(`${APP}/api/admin/users`, {
      headers: { cookie: cookie() },
      redirect: "manual",
    });
    const bouncedToLogin = (after.headers.get("location") ?? "").includes("/login");
    check(
      "the session no longer reaches an admin-only endpoint",
      after.status !== 200 && (after.status === 401 || after.status === 307) && bouncedToLogin,
      `got ${after.status} location=${after.headers.get("location")}`,
    );

    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } },
    );
    const { error } = await anon.auth.signInWithPassword({
      email: ACCOUNTS.admin,
      password: PASSWORD,
    });
    check("the account can sign in again afterwards", !error, error?.message);
  }

  // ---- 6. the disposable person is removed --------------------------------
  console.log("\ncleanup\n");
  if (SCRATCH.id) {
    const { createAdminClient } = await import("../server/supabase/admin-core");
    const svc = createAdminClient();
    const { data: found } = await svc
      .from("employees")
      .select("id")
      .eq("email", scratchEmail)
      .maybeSingle();

    if (found) {
      await svc.from("leave_approval_steps").delete().eq("approver_employee_id", found.id);
      await svc.from("leave_balances").delete().eq("employee_id", found.id);
      await svc.from("leave_requests").delete().eq("employee_id", found.id);
      await svc.from("employees").delete().eq("id", found.id);
      const { data: users } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const authUser = users?.users?.find((u) => u.email === scratchEmail);
      if (authUser) await svc.auth.admin.deleteUser(authUser.id);
    }

    const { count } = await svc
      .from("employees")
      .select("id", { count: "exact", head: true })
      .eq("email", scratchEmail);
    check("the disposable person is gone", (count ?? 0) === 0, `${count} left`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();