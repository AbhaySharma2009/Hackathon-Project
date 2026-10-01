/**
 * Phase 4 tests — the org chart and the leave calendar.
 *
 * Both features are pure reads assembled by Postgres:
 *   - `get_org_tree()` builds the hierarchy in the database, so the API test
 *     asserts the real nesting rather than re-deriving it in TypeScript.
 *   - /api/calendar scopes approved leave to the viewer's team and returns one
 *     record per request; the month grid turns a request into a bar that spans
 *     contiguous days, so the assertions here are on the request's own span.
 *
 * Subjects:
 *   Neha Gupta   (007) employee, reports to Sanjay Kapoor (006)
 *   Sanjay       (006) manager of Neha, Priya and Karthik
 *   Vikram       (002) VP Engineering, a level above Sanjay
 *   Rohan Iyer   (015) HR
 *   Aditya Rao   (001) CEO, the single root
 *
 *   npm test
 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../server/supabase/admin-core";

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
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const PASSWORD = "OrgFlow@2026";

const ADITYA = "00000000-0000-4000-8000-000000000001"; // CEO, single root
const VIKRAM = "00000000-0000-4000-8000-000000000002"; // VP Engineering
const SANJAY = "00000000-0000-4000-8000-000000000006"; // Engineering Manager
const NEHA = "00000000-0000-4000-8000-000000000007"; // Senior Backend Engineer
const PRIYA = "00000000-0000-4000-8000-000000000009"; // DevOps Engineer
const KATHIK = "00000000-0000-4000-8000-000000000008"; // Frontend Engineer
const ARJUN = "00000000-0000-4000-8000-000000000011"; // Product Designer
const ISHITA = "00000000-0000-4000-8000-000000000010"; // Product Lead, Arjun's manager
const ANANYA = "00000000-0000-4000-8000-000000000003"; // Head of Product
const RAHUL = "00000000-0000-4000-8000-000000000004"; // Head of Sales
const MEERA = "00000000-0000-4000-8000-000000000005"; // Head of People & Operations
const FATIMA = "00000000-0000-4000-8000-000000000013"; // Account Executive

/**
 * The one reason string this file writes. Cleanup can target it exactly, so a
 * run that is killed before `afterAll` leaves nothing behind for the next run —
 * approved leave is protected by an exclusion constraint, so a leftover fixture
 * would otherwise make the next run fail to insert.
 */
const FIXTURE_REASON = "Phase 4 calendar fixture.";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A real session cookie, the same way the app obtains one. */
async function cookieFor(email: string): Promise<string> {
  const { createServerClient } = await import("@supabase/ssr");
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
  if (error) throw error;
  return [...store].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function api(cookie: string, path: string) {
  const response = await fetch(`${APP_URL}${path}`, { headers: { Cookie: cookie } });
  return { status: response.status, body: await response.json() };
}

/** Inserts a leave request directly as an approved/pending fixture. */
async function insertRequest(
  employeeId: string,
  start: string,
  end: string,
  status: "approved" | "pending",
  days: number,
): Promise<string> {
  const { data, error } = await admin
    .from("leave_requests")
    .insert({
      employee_id: employeeId,
      leave_type: "casual",
      start_date: start,
      end_date: end,
      days,
      reason: FIXTURE_REASON,
      status,
      ...(status === "approved" ? { decided_by: SANJAY, decided_at: "2026-09-01T00:00:00Z" } : {}),
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

/**
 * Runs raw SQL through the Supabase management API. Only needed for the cycle
 * test, which has to defeat `employees_prevent_manager_cycle`. Skipped when no
 * management token is available.
 */
function managementToken(): string | null {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  try {
    return readFileSync(join(homedir(), ".supabase", "access-token"), "utf8").trim();
  } catch {
    return null;
  }
}

async function sql(statement: string) {
  const token = managementToken();
  if (!token) return null;
  const projectRef = URL.split("//")[1].split(".")[0];
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: statement }),
    },
  );
  if (!response.ok) throw new Error(`SQL failed (${response.status}): ${await response.text()}`);
  const rows = (await response.json()) as Record<string, unknown>[];
  if (rows[0]?.error) throw new Error(`SQL failed: ${rows[0].error}`);
  return rows;
}

// ---------------------------------------------------------------------------
// tree walking, for assertions only — never used to build the tree
// ---------------------------------------------------------------------------

type Node = {
  id: string;
  name: string;
  department: string;
  direct_report_count: number;
  children: Node[];
};

function flatten(nodes: Node[]): Node[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function find(nodes: Node[], id: string): Node | undefined {
  return flatten(nodes).find((node) => node.id === id);
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

let admin: SupabaseClient;
let employeeCookie: string; // Neha
let managerCookie: string; // Sanjay
let hrCookie: string; // Rohan

beforeAll(async () => {
  if (!URL || !ANON_KEY) throw new Error("Missing Supabase env vars — see .env.example");
  admin = createAdminClient();

  // Clear anything a previously interrupted run left behind, so the exclusion
  // constraint on overlapping approved leave cannot block these fixtures.
  await admin.from("leave_requests").delete().eq("reason", FIXTURE_REASON);

  employeeCookie = await cookieFor("neha.gupta@orgflow.dev");
  managerCookie = await cookieFor("sanjay.kapoor@orgflow.dev");
  hrCookie = await cookieFor("rohan.iyer@orgflow.dev");
});

afterAll(async () => {
  await admin.from("leave_requests").delete().eq("reason", FIXTURE_REASON);
});

// ===========================================================================
// Org chart
// ===========================================================================
describe("GET /api/org-chart", () => {
  it("requires a session", async () => {
    // `manual` so the assertion sees the redirect itself rather than the login
    // page it points at.
    const response = await fetch(`${APP_URL}/api/org-chart`, { redirect: "manual" });
    expect([401, 307]).toContain(response.status);
  });

  it("builds the hierarchy from manager_id, nested in the database", async () => {
    const { status, body } = await api(hrCookie, "/api/org-chart");
    expect(status).toBe(200);

    const tree = body.data as Node[];
    expect(Array.isArray(tree)).toBe(true);

    // The seed is a single-root org.
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe(ADITYA);
    expect(tree[0].name).toBe("Aditya Rao");

    // Neha is four levels down: Aditya → Vikram → Sanjay → Neha.
    const neha = find(tree, NEHA);
    expect(neha?.name).toBe("Neha Gupta");
    expect(neha?.department).toBe("Engineering");

    const chain = [SANJAY, VIKRAM].map((id) => find(tree, id));
    expect(chain.every(Boolean)).toBe(true);
    // Sanjay reports to Vikram, who reports to Aditya.
    expect(find(tree, SANJAY)?.direct_report_count).toBe(3);
    expect(find(tree, VIKRAM)?.direct_report_count).toBe(1);
  });

  it("parents each employee under their manager", async () => {
    const { body } = await api(hrCookie, "/api/org-chart");
    const tree = body.data as Node[];

    // Arjun's manager is Ishita, so Arjun must be a direct child of Ishita.
    const ishita = find(tree, ISHITA)!;
    expect(ishita.children.map((c) => c.id)).toContain(ARJUN);

    // And Ishita herself sits under the Head of Product.
    const ananya = find(tree, ANANYA)!;
    expect(ananya.children.map((c) => c.id)).toContain(ISHITA);
  });

  it("counts direct reports, not the whole subtree", async () => {
    const { body } = await api(hrCookie, "/api/org-chart");
    const tree = body.data as Node[];

    // Aditya has 4 direct reports (Engineering, Product, Sales, People) and the
    // whole company beneath him, so a subtree count would be far larger.
    const aditya = find(tree, ADITYA)!;
    expect(aditya.direct_report_count).toBe(4);
    expect(flatten([aditya]).length).toBeGreaterThan(aditya.direct_report_count);
  });

  it("includes every active employee exactly once", async () => {
    const { body } = await api(hrCookie, "/api/org-chart");
    const tree = body.data as Node[];

    const ids = flatten(tree).map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);

    const { data: active } = await admin
      .from("employees")
      .select("id")
      .eq("is_active", true);
    expect(ids.sort()).toEqual((active ?? []).map((e) => e.id).sort());
  });

  it("is visible to an ordinary employee", async () => {
    const { status, body } = await api(employeeCookie, "/api/org-chart");
    expect(status).toBe(200);
    expect((body.data as Node[]).length).toBeGreaterThan(0);
  });

  it("excludes an employee who has been deactivated", async () => {
    await admin.from("employees").update({ is_active: false }).eq("id", FATIMA);

    try {
      const { body } = await api(hrCookie, "/api/org-chart");
      expect(find(body.data as Node[], FATIMA)).toBeUndefined();
    } finally {
      await admin.from("employees").update({ is_active: true }).eq("id", FATIMA);
    }

    const restored = await api(hrCookie, "/api/org-chart");
    expect(find(restored.body.data as Node[], FATIMA)).toBeDefined();
  });
});

describe("get_org_tree edge cases", () => {
  it("promotes a new top level when the CEO is deactivated", async () => {
    if (!managementToken()) return; // no management token, skip the data change

    await admin.from("employees").update({ is_active: false }).eq("id", ADITYA);
    try {
      const { data } = await admin.rpc("get_org_tree");
      const tree = data as unknown as Node[];

      // The four department heads become roots rather than being dropped.
      expect(tree.map((n) => n.id).sort()).toEqual(
        [ANANYA, RAHUL, MEERA, VIKRAM].sort(),
      );
      // Everyone is still reachable exactly once.
      const ids = flatten(tree).map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await admin.from("employees").update({ is_active: true }).eq("id", ADITYA);
    }

    const { data } = await admin.rpc("get_org_tree");
    expect((data as unknown as Node[]).length).toBe(1);
  });

  it("terminates instead of looping when manager_id forms a cycle", async () => {
    if (!managementToken()) return;

    // The trigger normally makes this impossible, so it has to be disabled to
    // prove the RPC's own path guard is what stops the recursion.
    await sql("alter table public.employees disable trigger employees_prevent_manager_cycle;");
    // Ishita reports to Arjun, who already reports to Ishita.
    await sql(
      `update public.employees set manager_id = '${ARJUN}' where id = '${ISHITA}';`,
    );

    try {
      const { data, error } = await admin.rpc("get_org_tree");
      expect(error).toBeNull();

      const ids = flatten(data as unknown as Node[]).map((n) => n.id);
      // The cyclic branch is cut, but the rest of the chart still renders.
      expect(ids).not.toContain(ARJUN);
      expect(ids.length).toBeLessThan(15);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await sql("alter table public.employees enable trigger employees_prevent_manager_cycle;");
      await sql(`update public.employees set manager_id = '${ANANYA}' where id = '${ISHITA}';`);
    }

    const { data } = await admin.rpc("get_org_tree");
    const ids = flatten(data as unknown as Node[]).map((n) => n.id);
    expect(ids).toContain(ARJUN);
    expect(ids.length).toBe(15);
  });

  it("reports no missing people on a healthy tree", async () => {
    const { body } = await api(hrCookie, "/api/org-chart");
    expect(body.meta.missing).toBe(0);
    expect(body.meta.node_count).toBe(15);
  });

  it("tells the chart when a cycle cost it people", async () => {
    if (!managementToken()) return;

    await sql("alter table public.employees disable trigger employees_prevent_manager_cycle;");
    await sql(`update public.employees set manager_id = '${ARJUN}' where id = '${ISHITA}';`);

    try {
      const { body } = await api(hrCookie, "/api/org-chart");
      // Ishita and Arjun are cut, so the chart says so rather than quietly
      // rendering a smaller company.
      expect(body.meta.missing).toBe(2);
    } finally {
      await sql("alter table public.employees enable trigger employees_prevent_manager_cycle;");
      await sql(`update public.employees set manager_id = '${ANANYA}' where id = '${ISHITA}';`);
    }

    const { body } = await api(hrCookie, "/api/org-chart");
    expect(body.meta.missing).toBe(0);
  });
});

// ===========================================================================
// Leave calendar
// ===========================================================================
describe("GET /api/calendar", () => {
  it("requires a session", async () => {
    const response = await fetch(`${APP_URL}/api/calendar?month=2026-10`, {
      redirect: "manual",
    });
    expect([401, 307]).toContain(response.status);
  });

  it("rejects a malformed month", async () => {
    const { status } = await api(hrCookie, "/api/calendar?month=october");
    expect(status).toBe(422);
  });

  it("shows the seeded October leave, with its full span preserved", async () => {
    // Neha's seeded approved leave runs 2026-10-10 → 2026-10-15. The grid draws
    // one bar across those cells, so the API must return the whole span as a
    // single record rather than one entry per day.
    const { status, body } = await api(hrCookie, "/api/calendar?month=2026-10");
    expect(status).toBe(200);

    const neha = (body.data as { employee_id: string; start_date: string; end_date: string }[])
      .filter((l) => l.employee_id === NEHA)
      .find((l) => l.start_date === "2026-10-10");

    expect(neha).toBeDefined();
    expect(neha!.end_date).toBe("2026-10-15");
  });

  it("returns approved leave only", async () => {
    const id = await insertRequest(NEHA, "2027-03-08", "2027-03-09", "pending", 2);

    const { body } = await api(hrCookie, "/api/calendar?month=2027-03");
    const ids = (body.data as { id: string }[]).map((l) => l.id);
    expect(ids).not.toContain(id);
  });

  it("shows a newly approved request in the same month", async () => {
    const id = await insertRequest(NEHA, "2027-04-05", "2027-04-07", "approved", 3);

    const { body } = await api(hrCookie, "/api/calendar?month=2027-04");
    const match = (body.data as { id: string; days: number }[]).find((l) => l.id === id);
    expect(match).toBeDefined();
    expect(match!.days).toBe(3);
  });

  it("returns a leave that straddles the month boundary", async () => {
    // 2027-05-28 (Fri) → 2027-06-01 (Tue): a bar clipped at the end of May.
    const id = await insertRequest(NEHA, "2027-05-28", "2027-06-01", "approved", 3);

    const may = await api(hrCookie, "/api/calendar?month=2027-05");
    const june = await api(hrCookie, "/api/calendar?month=2027-06");

    // The same request appears in both months, keeping its true end date so the
    // bar continues past the boundary instead of being truncated.
    for (const body of [may.body, june.body]) {
      const match = (body.data as { id: string; end_date: string }[]).find((l) => l.id === id);
      expect(match).toBeDefined();
      expect(match!.end_date).toBe("2027-06-01");
    }
  });

  it("excludes a leave that ends before the month starts", async () => {
    await insertRequest(NEHA, "2027-06-07", "2027-06-09", "approved", 3);
    const { body } = await api(hrCookie, "/api/calendar?month=2027-07");
    expect(body.data).toEqual([]);
  });
});

describe("GET /api/calendar role scope", () => {
  // Scope can only be observed on people who actually have approved leave, so
  // this month gives one to Neha and both of her teammates, to an employee in
  // another reporting line, and to someone in a different department.
  const SCOPE_MONTH = "2027-09";

  beforeAll(async () => {
    await insertRequest(NEHA, "2027-09-06", "2027-09-07", "approved", 2);
    await insertRequest(PRIYA, "2027-09-07", "2027-09-08", "approved", 2);
    await insertRequest(KATHIK, "2027-09-08", "2027-09-09", "approved", 2);
    await insertRequest(ARJUN, "2027-09-13", "2027-09-14", "approved", 2);
    await insertRequest(FATIMA, "2027-09-20", "2027-09-21", "approved", 2);
  });

  it("shows an employee their own team, not the whole company", async () => {
    const { body } = await api(employeeCookie, `/api/calendar?month=${SCOPE_MONTH}`);
    const ids = new Set((body.data as { employee_id: string }[]).map((l) => l.employee_id));

    // Neha and her teammates share a manager, so they all appear.
    for (const id of [NEHA, PRIYA, KATHIK]) expect(ids.has(id)).toBe(true);
    // A different reporting line must not.
    expect(ids.has(ARJUN)).toBe(false);
    expect(ids.has(FATIMA)).toBe(false);
  });

  it("shows a manager their reports", async () => {
    const { body } = await api(managerCookie, `/api/calendar?month=${SCOPE_MONTH}`);
    const ids = new Set((body.data as { employee_id: string }[]).map((l) => l.employee_id));

    expect(ids.has(NEHA)).toBe(true);
    expect(ids.has(PRIYA)).toBe(true);
    expect(ids.has(KATHIK)).toBe(true);
    expect(ids.has(ARJUN)).toBe(false);
    expect(ids.has(FATIMA)).toBe(false);
  });

  it("shows HR the whole organisation", async () => {
    const { body } = await api(hrCookie, `/api/calendar?month=${SCOPE_MONTH}`);
    const ids = new Set((body.data as { employee_id: string }[]).map((l) => l.employee_id));

    for (const id of [NEHA, PRIYA, KATHIK, ARJUN, FATIMA]) expect(ids.has(id)).toBe(true);
  });

  it("gives HR a wider slice than any single team", async () => {
    const { body } = await api(hrCookie, `/api/calendar?month=${SCOPE_MONTH}`);
    const departments = new Set(
      (body.data as { employee_department: string }[]).map((l) => l.employee_department),
    );
    // Engineering plus the two other departments seeded above.
    expect(departments.size).toBeGreaterThan(1);
  });

  it("cannot be widened by asking for another team", async () => {
    // A crafted `team` id must not reach outside the caller's scope.
    const { body } = await api(employeeCookie, `/api/calendar?month=${SCOPE_MONTH}&team=${SANJAY}`);
    const ids = new Set((body.data as { employee_id: string }[]).map((l) => l.employee_id));
    expect(ids.has(ARJUN)).toBe(false);
    expect(ids.has(FATIMA)).toBe(false);
  });

  it("rejects a non-uuid team id", async () => {
    const { status } = await api(hrCookie, "/api/calendar?month=2026-10&team=not-a-uuid");
    expect(status).toBe(422);
  });
});

describe("GET /api/calendar filters", () => {
  it("narrows to a department", async () => {
    await insertRequest(NEHA, "2027-07-05", "2027-07-06", "approved", 2);
    await insertRequest(ARJUN, "2027-07-12", "2027-07-13", "approved", 2);

    const { body } = await api(hrCookie, "/api/calendar?month=2027-07&department=Engineering");
    const departments = new Set(
      (body.data as { employee_department: string }[]).map((l) => l.employee_department),
    );
    expect([...departments]).toEqual(["Engineering"]);
  });

  it("narrows to a team", async () => {
    await insertRequest(NEHA, "2027-08-02", "2027-08-03", "approved", 2);
    await insertRequest(ARJUN, "2027-08-09", "2027-08-10", "approved", 2);

    // Arjun reports to Ishita, so Ishita's team is the one containing him.
    const { body } = await api(hrCookie, `/api/calendar?month=2027-08&team=${ISHITA}`);
    const ids = new Set((body.data as { employee_id: string }[]).map((l) => l.employee_id));

    expect(ids.has(ARJUN)).toBe(true);
    expect(ids.has(NEHA)).toBe(false);
  });

  it("returns every row once, with the directory fields the grid renders", async () => {
    const { body } = await api(hrCookie, "/api/calendar?month=2026-10");
    const rows = body.data as {
      id: string;
      employee_name: string;
      employee_photo: unknown;
      employee_department: string;
    }[];

    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.employee_name).toBeTruthy();
      expect(row.employee_department).toBeTruthy();
    }
  });
});

describe("realtime plumbing for the calendar", () => {
  it("publishes leave_requests, so a fresh approval reaches the calendar", async () => {
    if (!managementToken()) return;

    const rows = await sql(
      `select relname
         from pg_class
         join pg_publication_rel on pg_class.oid = pg_publication_rel.prrelid
         join pg_publication on pg_publication.oid = pg_publication_rel.prpubid
        where pubname = 'supabase_realtime' and relname = 'leave_requests';`,
    );
    expect(rows?.[0]).toMatchObject({ relname: "leave_requests" });
  });

  it("publishes employees, so a re-parented report re-renders the chart", async () => {
    if (!managementToken()) return;

    const rows = await sql(
      `select relname
         from pg_class
         join pg_publication_rel on pg_class.oid = pg_publication_rel.prrelid
         join pg_publication on pg_publication.oid = pg_publication_rel.prpubid
        where pubname = 'supabase_realtime' and relname = 'employees';`,
    );
    expect(rows?.[0]).toMatchObject({ relname: "employees" });
  });
});
