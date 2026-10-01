/**
 * Provisions a dedicated Supabase project for the integration suites.
 *
 * The eight `tests/*.test.ts` files assert whole-database state — a single
 * reporting root, exactly 15 active employees, department names, and the seeded
 * leave requests — and they approve leave, which spends balances permanently.
 * Running them against the demo project would both fail (the demo dataset is a
 * different org, with its own root) and quietly corrupt the demo data.
 *
 * So they get their own project, built here from the same migrations plus
 * `supabase/seed.sql`, which still holds the original 15-person organisation
 * those suites were written against.
 *
 * Credentials come from `.env.test.local` (gitignored):
 *
 *   SUPABASE_PROJECT_REF=<ref>
 *   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
 *   SUPABASE_SERVICE_ROLE_KEY=<service role key>
 *
 * The service-role key is read here but must never reach the browser or a
 * committed file; that is why it lives in a gitignored file and why this script
 * refuses to run without one.
 *
 *   npm run db:setup-test
 *
 * Safe to re-run: every migration is idempotent (they are written with
 * `create or replace` / `drop ... if exists`), and auth users are located by
 * email rather than recreated.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Load the test project's credentials into the environment *before* anything
 * else calls dotenv.
 *
 * dotenv does not overwrite variables that already exist, so seeding
 * `process.env` here means the `.env.local` loads performed by imported modules
 * cannot quietly point the whole run back at the demo project. That ordering is
 * the only thing preventing this script from touching production data.
 */
function loadTestEnv(): { ref: string } {
  config({ path: ".env.test.local" });

  const ref = process.env.SUPABASE_PROJECT_REF;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!ref || !url || !serviceKey) {
    console.error(
      "missing test credentials. Create .env.test.local with:\n" +
        "  SUPABASE_PROJECT_REF=<ref>\n" +
        "  NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co\n" +
        "  NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>\n" +
        "  SUPABASE_SERVICE_ROLE_KEY=<service role key>\n",
    );
    process.exit(1);
  }

  if (!url.includes(ref)) {
    // Guards against a mismatched pair, which would apply the schema to one
    // project and then seed a different one.
    console.error(`refusing to continue: ${url} does not belong to project ${ref}`);
    process.exit(1);
  }

  if (
    ref === LIVE_PROJECT_REF ||
    (process.env.SUPABASE_LIVE_PROJECT_REF && ref === process.env.SUPABASE_LIVE_PROJECT_REF)
  ) {
    console.error(`refusing to continue: ${ref} is the live demo project`);
    process.exit(1);
  }

  return { ref };
}

// `loadTestEnv` has to run before anything reads credentials, but static imports
// are hoisted. That is safe here because none of the imported modules capture
// the environment at load time — dotenv, the Supabase client and node:fs all
// read it lazily, inside the calls in `main`.
const DEMO_PASSWORD = "OrgFlow@2026";

/**
 * The demo project this repository is deployed against.
 *
 * Hard-coded so the guard below works with no configuration: this script
 * applies every migration and then writes data, and pointing it at the live
 * project by mistake would destroy the demo dataset. `SUPABASE_LIVE_PROJECT_REF`
 * overrides this if the demo project ever moves.
 */
const LIVE_PROJECT_REF =
  process.env.SUPABASE_LIVE_PROJECT_REF ?? "rievmffkvabkhmjdmqif";

function token(): string {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  return readFileSync(join(homedir(), ".supabase", "access-token"), "utf8").trim();
}

async function runSql(ref: string, label: string, sql: string) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`\nFAILED at ${label} (HTTP ${response.status})\n${detail.slice(0, 800)}`);
    process.exit(1);
  }
  console.log(`  ok  ${label}`);
}

/**
 * Migrations in filename order.
 *
 * `0004b_` sorts after `0004_`, which is the intended order: the hierarchical
 * approval rework builds on the original approval RPC. Plain lexicographic sort
 * gets this right, so no hand-maintained list to drift.
 */
function migrations(): string[] {
  return readdirSync("supabase/migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => join("supabase/migrations", name));
}

async function main() {
  const { ref } = loadTestEnv();
  console.log(`provisioning test project ${ref}\n`);

  console.log("migrations");
  for (const file of migrations()) {
    await runSql(ref, file, readFileSync(file, "utf8"));
  }

  console.log("\nseed data");
  await runSql(ref, "supabase/seed.sql", readFileSync("supabase/seed.sql", "utf8"));

  console.log("\nauth accounts");
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: staff, error } = await supabase
    .from("employees")
    .select("id, email, name, app_role")
    .eq("is_active", true);

  if (error) throw error;

  const existing = new Map<string, string>();
  for (let page = 1; page <= 10; page++) {
    const { data: list } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    for (const user of list?.users ?? []) {
      if (user.email) existing.set(user.email, user.id);
    }
    if (!list?.users?.length || list.users.length < 1000) break;
  }

  for (const person of staff ?? []) {
    let authUserId = existing.get(person.email);

    if (!authUserId) {
      const { data, error: createError } = await supabase.auth.admin.createUser({
        email: person.email,
        password: DEMO_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: person.name, role: person.app_role },
      });
      if (createError) throw new Error(`${person.email}: ${createError.message}`);
      authUserId = data.user.id;
    }

    await supabase
      .from("employees")
      .update({ auth_user_id: authUserId })
      .eq("id", person.id);
  }

  console.log(`  ok  ${staff?.length ?? 0} auth accounts`);

  const { data: roots } = await supabase.from("employees").select("id, name");
  console.log(
    `\nready. ${roots?.length ?? 0} employees; password ${DEMO_PASSWORD} for all accounts.`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});