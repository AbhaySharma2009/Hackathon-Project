/**
 * Phase 12 — fresh 6-user demo dataset.
 *
 * Run AFTER `npm run db:reset-demo`. Creates exactly six people, their auth
 * accounts, their leave balances, and a realistic spread of leave history with
 * real approval chains.
 *
 * ## Why this inserts rows instead of calling `create_leave_request`
 *
 * `validate_leave_request_internal` rejects any request starting before
 * `current_date` (migration 0003, "Leave cannot start in the past"). A demo needs
 * *history* — approved, rejected and cancelled requests in the past — so those
 * rows are written directly with the service role, exactly as `supabase/seed.sql`
 * did. Requested days always come from the database's own `working_days`, never
 * hardcoded.
 *
 * ## Why chains are still genuine
 *
 * Every request is handed to the real `build_approval_chain` RPC, so the
 * approvers, levels, `skipped` steps and `approval_blocked` state all come out
 * of the production approval engine rather than being asserted by hand. The
 * script then settles the steps to match each request's intended outcome.
 *
 * ## The topology is deliberate
 *
 * Six people cannot express a deep org chart, so these six are chosen to still
 * cover every shape the approval engine distinguishes:
 *   - Aditya  root of the tree (no manager)  -> his own leave cannot route
 *   - Sanjay  his department head IS his own manager -> level 2 `skipped`
 *   - Vikram  a manager in another department -> must be refused on others' leave
 *   - Rohan   the single HR -> level 3 signature and org-wide override
 *   - Neha / Priya  employees under Sanjay -> 1, 2 and 3 level chains
 *
 *   npm run db:seed-demo
 */
import { config } from "dotenv";
import { createAdminClient } from "../server/supabase/admin-core";

config({ path: ".env.local" });
config();

const DEMO_PASSWORD = "OrgFlow@2026";

/** Deterministic ids for the demo org, in a namespace distinct from the old seed. */
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const photo = (n: number) => `https://i.pravatar.cc/300?img=${n}`;

import type { AppRole } from "../shared/types";
type LeaveType = "casual" | "sick" | "annual" | "unpaid";

type Person = {
  key: string;
  id: string;
  name: string;
  email: string;
  photo: string;
  role: string;
  app_role: AppRole;
  department: string;
  manager: string | null;
  join_date: string;
};

/** Join dates are absolute; leave dates are relative to the current year. */
const PEOPLE: Person[] = [
  // Phase 15 adds the top tier above Admin. They sit at the very top of the
  // reporting line, which is also what makes them the approver for an Admin's
  // own leave. Kept first so the hierarchy reads top-down.
  {
    key: "superAdmin",
    id: id(99),
    name: "Ananya Iyer",
    email: "ananya.iyer@orgflow.dev",
    photo: photo(10),
    role: "Chief Operating Officer",
    app_role: "super_admin",
    department: "HR & Operations",
    manager: null,
    join_date: "2016-02-01",
  },
  // Phase 14: the administrator tier sits above HR and reaches the admin console.
  // Kept at the top of the list so the hierarchy reads admin-first.
  {
    key: "admin",
    id: id(100),
    name: "Meera Krishnan",
    email: "meera.krishnan@orgflow.dev",
    photo: photo(11),
    role: "Head of People Operations",
    app_role: "admin",
    department: "HR & Operations",
    manager: "superAdmin",
    join_date: "2018-01-08",
  },
  {
    key: "root",
    id: id(101),
    name: "Aditya Rao",
    email: "aditya.rao@orgflow.dev",
    photo: photo(12),
    role: "Chief Executive Officer",
    app_role: "manager",
    department: "Engineering",
    manager: "admin",
    join_date: "2019-03-11",
  },
  {
    key: "mgrEng",
    id: id(102),
    name: "Sanjay Kapoor",
    email: "sanjay.kapoor@orgflow.dev",
    photo: photo(13),
    role: "Engineering Manager",
    app_role: "manager",
    department: "Engineering",
    manager: "root",
    join_date: "2020-09-14",
  },
  {
    key: "mgrSales",
    id: id(103),
    name: "Vikram Sethi",
    email: "vikram.sethi@orgflow.dev",
    photo: photo(14),
    role: "Head of Sales",
    app_role: "manager",
    department: "Sales",
    manager: "root",
    join_date: "2021-06-21",
  },
  {
    key: "hr",
    id: id(104),
    name: "Rohan Iyer",
    email: "rohan.iyer@orgflow.dev",
    photo: photo(15),
    role: "Head of People & Operations",
    app_role: "hr",
    department: "HR & Operations",
    manager: "root",
    join_date: "2020-08-17",
  },
  {
    key: "emp1",
    id: id(105),
    name: "Neha Gupta",
    email: "neha.gupta@orgflow.dev",
    photo: photo(16),
    role: "Senior Backend Engineer",
    app_role: "employee",
    department: "Engineering",
    manager: "mgrEng",
    join_date: "2021-02-01",
  },
  {
    key: "emp2",
    id: id(106),
    name: "Priya Nair",
    email: "priya.nair@orgflow.dev",
    photo: photo(17),
    role: "Frontend Engineer",
    app_role: "employee",
    department: "Engineering",
    manager: "mgrEng",
    join_date: "2021-07-19",
  },
];

const byKey = new Map(PEOPLE.map((p) => [p.key, p]));

/** Allocated leave per person per type, for the current year. */
const ALLOCATION: Record<string, Record<LeaveType, number>> = {
  superAdmin: { casual: 12, sick: 10, annual: 25, unpaid: 0 },
  admin: { casual: 12, sick: 10, annual: 22, unpaid: 0 },
  root: { casual: 10, sick: 10, annual: 25, unpaid: 0 },
  mgrEng: { casual: 12, sick: 10, annual: 22, unpaid: 0 },
  mgrSales: { casual: 12, sick: 10, annual: 20, unpaid: 0 },
  hr: { casual: 12, sick: 10, annual: 20, unpaid: 0 },
  emp1: { casual: 12, sick: 10, annual: 20, unpaid: 0 },
  emp2: { casual: 12, sick: 8, annual: 18, unpaid: 0 },
};

type Outcome =
  | { kind: "approved"; comments?: Record<number, string> }
  | { kind: "rejected"; approver: string; comment: string }
  | { kind: "cancelled" }
  | { kind: "pending" };

type RequestSpec = {
  employee: string;
  leave_type: LeaveType;
  /** [month, day] in the current year. */
  start: [number, number];
  end: [number, number];
  reason: string;
  /** [month, day] the request was raised. */
  created: [number, number];
  outcome: Outcome;
};

const REQUESTS: RequestSpec[] = [
  {
    employee: "emp2",
    leave_type: "casual",
    start: [5, 11],
    end: [5, 12],
    created: [5, 4],
    reason: "Family function out of town.",
    outcome: {
      kind: "rejected",
      approver: "mgrEng",
      comment: "Two engineers are already off that week — please push this to next month.",
    },
  },
  {
    employee: "emp1",
    leave_type: "annual",
    start: [6, 15],
    end: [6, 19],
    created: [5, 20],
    reason: "Annual break with family.",
    outcome: {
      kind: "approved",
      comments: {
        1: "Enjoy the break, Neha.",
        2: "Approved at department level. Enjoy the time off.",
      },
    },
  },
  {
    employee: "mgrSales",
    leave_type: "annual",
    // Deliberately 1-3 days. A 4-7 day request would need a Sales department head,
    // and Vikram's only ancestor (Aditya) sits in Engineering, so `resolve_department_head`
    // returns NULL and the engine parks it as `approval_blocked` instead of routing.
    start: [7, 6],
    end: [7, 7],
    created: [6, 18],
    reason: "Planned vacation.",
    outcome: { kind: "approved", comments: { 1: "Fine. Sales coverage is in place." } },
  },
  {
    employee: "emp1",
    leave_type: "casual",
    start: [8, 5],
    end: [8, 6],
    created: [8, 3],
    reason: "Personal work at home.",
    outcome: { kind: "approved", comments: { 1: "No issues, take care." } },
  },
  {
    employee: "emp2",
    leave_type: "sick",
    start: [9, 2],
    end: [9, 3],
    created: [9, 2],
    reason: "Recovering from a viral infection.",
    outcome: { kind: "approved", comments: { 1: "Rest up and get well soon." } },
  },
  {
    employee: "emp2",
    leave_type: "annual",
    start: [10, 5],
    end: [10, 6],
    created: [9, 28],
    reason: "Long weekend trip.",
    outcome: { kind: "pending" },
  },
  {
    employee: "emp2",
    leave_type: "casual",
    start: [10, 19],
    end: [10, 23],
    created: [9, 29],
    reason: "Moving house.",
    outcome: { kind: "pending" },
  },
  {
    employee: "mgrEng",
    leave_type: "annual",
    start: [11, 2],
    end: [11, 6],
    created: [10, 5],
    reason: "Annual leave.",
    outcome: { kind: "pending" },
  },
  {
    employee: "emp2",
    leave_type: "annual",
    start: [11, 9],
    end: [11, 13],
    created: [10, 1],
    reason: "Attending a wedding abroad.",
    outcome: { kind: "cancelled" },
  },
  {
    employee: "emp1",
    leave_type: "annual",
    start: [12, 7],
    end: [12, 18],
    created: [9, 20],
    reason: "Winter holiday with parents.",
    outcome: { kind: "pending" },
  },
  {
    employee: "root",
    leave_type: "annual",
    start: [12, 21],
    end: [12, 23],
    created: [9, 25],
    reason: "Year-end break.",
    outcome: { kind: "pending" },
  },
];

function fail(message: string): never {
  throw new Error(message);
}

type QueryResult<T> = { data: T; error: { message: string } | null };

/** Transport-level failures seen against this project's Supabase instance. */
const TRANSIENT =
  /fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|network|timeout|timed out/i;

/**
 * A single call must not be able to hang the whole seed.
 *
 * Against this project, PostgREST requests have been observed both failing fast
 * and hanging indefinitely, and the client applies no timeout of its own. This
 * races each call against a deadline so `attempt` can retry instead of blocking
 * forever. The underlying request is abandoned, not cancelled.
 */
const CALL_TIMEOUT_MS = 20_000;

function withTimeout<T>(label: string, pending: PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: timed out after ${CALL_TIMEOUT_MS}ms`)),
      CALL_TIMEOUT_MS,
    );
    Promise.resolve(pending).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Run one Supabase call, retrying only transport failures.
 *
 * The Supabase client reports a dropped connection as an ordinary `error` rather
 * than throwing, so retrying on thrown exceptions alone would silently give up.
 * Constraint and permission violations are NOT retried: they fail identically
 * every time, and retrying them would just bury the real message under retries.
 *
 * The callback returns a `PromiseLike` because a PostgREST builder is a thenable
 * carrying extra methods, not a real `Promise`.
 */
async function attempt<T>(
  label: string,
  fn: () => PromiseLike<QueryResult<T>>,
  tries = 4,
): Promise<T> {
  let last = "unknown";
  for (let i = 1; i <= tries; i += 1) {
    let result: QueryResult<T>;
    try {
      result = await withTimeout(label, fn());
    } catch (thrown) {
      last = String(thrown);
      if (!TRANSIENT.test(last) || i === tries) throw new Error(`${label}: ${last}`);
      const waitThrown = i * 1000;
      console.warn(`  ${label}: ${last} — retrying in ${waitThrown}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitThrown));
      continue;
    }
    if (!result.error) return result.data;

    last = result.error.message;
    if (!TRANSIENT.test(last) || i === tries) throw new Error(`${label}: ${last}`);
    const waitMs = i * 1000;
    console.warn(`  ${label}: ${last} — retrying in ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error(`${label}: ${last}`);
}

async function main() {
  const admin = createAdminClient();
  // `build_approval_chain` is service-role-only and intentionally absent from the
  // hand-written Database mirror, so the internal calls go through this alias.
  const internal = admin as unknown as {
    rpc: (
      fn: string,
      args?: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };

  const year = new Date().getFullYear();
  const iso = ([m, d]: [number, number]) =>
    `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  const existing = await attempt("employees (pre-check)", () =>
    admin.from("employees").select("id").limit(1),
  );
  if (existing && existing.length > 0) {
    fail(
      `employees table is not empty (${existing.length}+ rows). Run "npm run db:reset-demo" first.`,
    );
  }

  // ---- people (parents before children, so the manager-cycle trigger is happy) ----
  const ordered = [...PEOPLE].sort((a, b) => {
    if (a.manager === null) return -1;
    if (b.manager === null) return 1;
    return PEOPLE.indexOf(a) - PEOPLE.indexOf(b);
  });

  await attempt("employees insert", () =>
    admin.from("employees").insert(
      ordered.map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        photo: p.photo,
        role: p.role,
        app_role: p.app_role,
        department: p.department,
        manager_id: p.manager ? byKey.get(p.manager)!.id : null,
        join_date: p.join_date,
        is_active: true,
      })),
    ),
  );
  console.log(`inserted ${ordered.length} employees`);

  // ---- balances for the current year (no trigger does this for us) ----
  const balanceRows = PEOPLE.flatMap((p) =>
    (Object.keys(ALLOCATION[p.key]) as LeaveType[]).map((t) => ({
      employee_id: p.id,
      year,
      leave_type: t,
      allocated: ALLOCATION[p.key][t],
      used: 0,
    })),
  );
  await attempt("leave_balances insert", () => admin.from("leave_balances").insert(balanceRows));
  console.log(`inserted ${balanceRows.length} leave balances for ${year}`);

  // ---- leave requests, each routed through the real approval engine ----
  const summary: Record<string, number> = {};

  for (const [index, spec] of REQUESTS.entries()) {
    const person = byKey.get(spec.employee) ?? fail(`unknown employee ${spec.employee}`);
    const requestId = id(200 + index);
    const start = iso(spec.start);
    const end = iso(spec.end);

    const days = await attempt("working_days", () =>
      admin.rpc("working_days", { start, end }),
    );
    if (!days || Number(days) <= 0) fail(`${person.name} ${start}..${end} has no working days`);

    await attempt("leave_requests insert", () =>
      admin.from("leave_requests").insert({
        id: requestId,
        employee_id: person.id,
        leave_type: spec.leave_type,
        start_date: start,
        end_date: end,
        days,
        reason: spec.reason,
        status: "pending",
        created_at: `${iso(spec.created)}T09:30:00Z`,
      }),
    );

    await attempt(`build_approval_chain(${requestId})`, () =>
      internal.rpc("build_approval_chain", { p_request_id: requestId }),
    );

    const request = await attempt("read request", () =>
      admin.from("leave_requests").select("status").eq("id", requestId).single(),
    );

    const steps = await attempt("read steps", () =>
      admin
        .from("leave_approval_steps")
        .select("id,level,status,approver_employee_id")
        .eq("leave_request_id", requestId)
        .order("level"),
    );
    const chain = steps ?? [];
    const actionable = chain.filter((s) => s.status === "pending");

    const settledAt = `${iso(spec.end)}T17:00:00Z`;
    const updateStep = (stepId: string, patch: Record<string, unknown>) =>
      attempt(`update step ${stepId}`, () =>
        admin.from("leave_approval_steps").update(patch).eq("id", stepId),
      );

    if (spec.outcome.kind === "approved") {
      const finalStep = actionable.at(-1);
      if (!finalStep) fail(`${person.name} ${start}: nothing to approve`);
      for (const step of actionable) {
        await updateStep(step.id, {
          status: "approved",
          comment:
            spec.outcome.kind === "approved" && spec.outcome.comments?.[step.level]
              ? spec.outcome.comments[step.level]
              : null,
          decided_at: settledAt,
        });
      }
      await attempt("approve request", () =>
        admin
          .from("leave_requests")
          .update({
            status: "approved",
            decided_by: finalStep.approver_employee_id,
          decided_at: settledAt,
          manager_comment: finalStep.level === 1 ? null : "Approved.",
        })
        .eq("id", requestId),
      );
    } else if (spec.outcome.kind === "rejected") {
      const approver = byKey.get(spec.outcome.approver) ?? fail("unknown approver");
      const target = actionable.find((s) => s.approver_employee_id === approver.id);
      if (!target) fail(`${person.name} ${start}: ${approver.name} cannot reject at this level`);
      await updateStep(target.id, {
        status: "rejected",
        comment: spec.outcome.comment,
        decided_at: settledAt,
      });
      for (const step of actionable.filter((s) => s.level > target.level)) {
        await updateStep(step.id, { status: "skipped" });
      }
      await attempt("reject request", () =>
        admin
          .from("leave_requests")
          .update({
            status: "rejected",
            decided_by: approver.id,
            decided_at: settledAt,
            manager_comment: spec.outcome.kind === "rejected" ? spec.outcome.comment : null,
          })
          .eq("id", requestId),
      );
    } else if (spec.outcome.kind === "cancelled") {
      for (const step of chain) {
        await updateStep(step.id, { status: "skipped" });
      }
      // No cancel RPC exists, so a self-cancelled request is written directly.
      await attempt("cancel request", () =>
        admin
          .from("leave_requests")
          .update({
            status: "cancelled",
            decided_by: person.id,
            decided_at: settledAt,
            manager_comment: "Cancelled by the requester.",
          })
          .eq("id", requestId),
      );
    }

    const status = spec.outcome.kind === "pending" ? (request?.status ?? "unknown") : spec.outcome.kind;
    summary[status] = (summary[status] ?? 0) + 1;
  }
  console.log(`inserted ${REQUESTS.length} leave requests:`, summary);

  // ---- balances: only a final approval spends leave ----
  const approved = await attempt("read approved", () =>
    admin.from("leave_requests").select("employee_id,leave_type,days").eq("status", "approved"),
  );

  for (const person of PEOPLE) {
    for (const type of Object.keys(ALLOCATION[person.key]) as LeaveType[]) {
      if (type === "unpaid") continue;
      const used = (approved ?? [])
        .filter((r) => r.employee_id === person.id && r.leave_type === type)
        .reduce((sum, r) => sum + Number(r.days), 0);
      await attempt("update used", () =>
        admin
          .from("leave_balances")
          .update({ used })
          .eq("employee_id", person.id)
          .eq("year", year)
          .eq("leave_type", type),
      );
    }
  }
  console.log("recomputed leave_balances.used from approved requests");

  // ---- auth accounts for exactly these six people ----
  for (const person of PEOPLE) {
    const created = await attempt(`auth create ${person.email}`, async () => {
      try {
        const result = await admin.auth.admin.createUser({
          email: person.email,
          password: DEMO_PASSWORD,
          email_confirm: true,
          user_metadata: { full_name: person.name, role: person.app_role },
        });
        // Unwrap, and propagate the real error rather than masking it — a
        // "no user id" message would otherwise hide why the account failed.
        return { data: result.data as unknown, error: result.error as { message: string } | null };
      } catch (error) {
        return { data: undefined as unknown, error: { message: String(error) } };
      }
    });

    const authUserId = (created as { user?: { id?: string } } | undefined)?.user?.id;
    if (!authUserId) fail(`auth create ${person.email} returned no user id`);

    await attempt(`link auth ${person.email}`, () =>
      admin.from("employees").update({ auth_user_id: authUserId }).eq("id", person.id),
    );
  }
  console.log(`created and linked ${PEOPLE.length} auth accounts`);

  // ---- alerts: notification + staleness + balance rules ----
  await attempt("generate_approval_alerts", () =>
    internal.rpc("generate_approval_alerts", { p_threshold_days: 2 }),
  );
  await attempt("generate_alerts", () => admin.rpc("generate_alerts"));

  // `head: true` puts the row count on the response rather than in `data`, so
  // read it off the raw result instead of `attempt`, which returns `data`.
  const { count: alertCount } = await admin.from("alerts").select("id", { count: "exact", head: true });
  console.log(`alerts now present: ${alertCount ?? 0}`);

  // ---- who signs the Super Admin's own leave ----
  // Phase 15 routes a Super Admin's leave to a configured fallback approver, and
  // with none configured the request is parked as blocked. Leaving the column
  // null would ship the demo dataset with a stranded request nobody can action,
  // so name the Managing Director. The Super Admin cannot be their own fallback.
  await attempt("configure the Super Admin fallback approver", () =>
    admin
      .from("approval_policy")
      .update({
        super_admin_fallback_employee_id: "11111111-1111-4111-8111-000000000101",
        updated_at: new Date().toISOString(),
      })
      .eq("id", true),
  );

  console.log(`\nDemo dataset ready. ${PEOPLE.length} people, password ${DEMO_PASSWORD}`);
  for (const p of PEOPLE) {
    console.log(`  ${p.app_role.padEnd(8)} ${p.email.padEnd(28)} ${p.department}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});