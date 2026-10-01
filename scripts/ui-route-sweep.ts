/**
 * Phase 10 regression sweep: renders every route as every role and fails on any
 * runtime error, RSC error boundary trip, hydration warning or 500 in the HTML.
 *
 * This is a UI-regression check only. It talks to the real Supabase project and
 * the running dev server, exactly as the integration suites do, but asserts on
 * rendered markup rather than on business rules.
 *
 *   npx tsx scripts/ui-route-sweep.ts
 */
import { config } from "dotenv";
import { navForRole } from "../shared/nav";
import { createServerClient } from "@supabase/ssr";

config({ path: ".env.local" });
config();

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const PASSWORD = process.env.DEMO_PASSWORD ?? "OrgFlow@2026";

type Role = "employee" | "manager" | "hr" | "admin" | "super_admin";

const ACCOUNTS: Record<Role, string> = {
  employee: "neha.gupta@orgflow.dev",
  manager: "sanjay.kapoor@orgflow.dev",
  hr: "rohan.iyer@orgflow.dev",
  admin: "meera.krishnan@orgflow.dev",
  super_admin: "ananya.iyer@orgflow.dev",
};

/** Every page a role might be sent to, permitted or not. */
const ROUTES = [
  "/dashboard",
  "/my-leaves",
  "/calendar",
  "/directory",
  "/org-chart",
  "/approvals",
  "/team-availability",
  "/hr-dashboard",
  "/alerts",
  "/smart-hr-query",
  "/admin",
  "/admin/users",
  "/admin/departments",
  "/admin/approval-hierarchy",
  "/admin/activity",
  "/super-admin",
  "/super-admin/access",
  "/settings",
] as const;

/**
 * Routes each role is expected to reach; every other route must redirect them away.
 *
 * Derived from `navForRole` rather than written out, because the navigation *is*
 * the specification of who can see what. A hand-kept copy drifted once already,
 * leaving a manager pointing at an HR-only dashboard that answered FORBIDDEN.
 */
const EXPECTED: Record<Role, string[]> = {
  employee: navForRole("employee").map((item) => item.href),
  manager: navForRole("manager").map((item) => item.href),
  hr: navForRole("hr").map((item) => item.href),
  admin: navForRole("admin").map((item) => item.href),
  super_admin: navForRole("super_admin").map((item) => item.href),
};

/** Where each role lands after signing in. Mirrors `homeForRole`. */
const LANDING: Record<Role, string> = {
  employee: "/dashboard",
  manager: "/dashboard",
  hr: "/hr-dashboard",
  admin: "/admin",
  super_admin: "/super-admin",
};

/**
 * Markers that mean the page threw. Next.js ships the error into the RSC payload
 * and/or renders its error overlay, so both are checked.
 */
const ERROR_MARKERS = [
  "Application error: a client-side exception",
  "Application error: a server-side exception",
  "data-dgst",
  "Internal Server Error",
  "digest is not defined",
  "Element type is invalid",
  "Objects are not valid as a React child",
  "Hydration failed",
  "is not a function",
  "Cannot read properties of undefined",
];

async function cookieFor(email: string): Promise<string> {
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
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return [...store].map(([name, value]) => `${name}=${value}`).join("; ");
}

let failures = 0;
let checks = 0;

function fail(message: string) {
  failures += 1;
  console.log(`  FAIL  ${message}`);
}

async function checkRoute(role: Role, cookie: string, route: string) {
  checks += 1;
  const shouldPass = EXPECTED[role].includes(route);
  const response = await fetch(`${APP_URL}${route}`, {
    headers: { Cookie: cookie },
    redirect: "manual",
  });

  // A route this role may not open must bounce them to their dashboard.
  if (!shouldPass) {
    const location = response.headers.get("location") ?? "";
    if (response.status >= 300 && response.status < 400 && location.includes("/dashboard")) {
      return;
    }
    fail(`${role} should be redirected away from ${route} (got ${response.status} ${location})`);
    return;
  }

  if (response.status !== 200) {
    fail(`${role} GET ${route} -> ${response.status}`);
    return;
  }

  const html = await response.text();
  for (const marker of ERROR_MARKERS) {
    if (html.includes(marker)) {
      fail(`${role} ${route} rendered an error: ${marker}`);
      return;
    }
  }

  // Every page must still own exactly one h1 after the redesign.
  const h1s = html.match(/<h1[\s>]/g)?.length ?? 0;
  if (h1s === 0) fail(`${role} ${route} has no h1`);
  if (h1s > 1) fail(`${role} ${route} has ${h1s} h1 elements (expected 1)`);

  // The sidebar must render its wordmark on every authenticated page.
  if (!html.includes("OrgFlow")) fail(`${role} ${route} is missing the OrgFlow brand`);
}

async function main() {
  for (const role of Object.keys(ACCOUNTS) as Role[]) {
    console.log(`\n${role}:`);
    const cookie = await cookieFor(ACCOUNTS[role]);

    // The landing page each role is sent to on sign-in.
    await checkRoute(role, cookie, LANDING[role]);

    for (const route of ROUTES) {
      await checkRoute(role, cookie, route);
    }
  }

  console.log(`\n${checks} route checks, ${failures} failure(s).`);
  if (failures > 0) process.exitCode = 1;
}

void main();
