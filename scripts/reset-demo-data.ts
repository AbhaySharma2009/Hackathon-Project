/**
 * Phase 12 — remove every demo/test account and all dependent data.
 *
 * This deletes DATA ONLY. It does not touch schema, migrations, RLS policies,
 * functions, triggers or application configuration: it never runs DDL and never
 * drops anything. Take a backup first (`npm run db:backup`).
 *
 * Order matters. `leave_approval_steps.approver_employee_id` is ON DELETE RESTRICT
 * (migration 0004b), so that table must be emptied before `employees`, or the
 * delete is rejected outright. Everything else cascades off `employees` or
 * `leave_requests`.
 *
 * `auth.users` is not reachable by cascade — `employees.auth_user_id` is
 * ON DELETE SET NULL, so deleting the employee orphans the row instead of the
 * auth user. Auth users must be removed explicitly via the admin API.
 *
 *   npm run db:reset-demo          # wipe data
 *   npm run db:reset-demo -- --dry-run
 */
import { config } from "dotenv";
import { createAdminClient } from "../server/supabase/admin-core";

config({ path: ".env.local" });
config();

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Data tables, in a safe deletion order. `leave_approval_steps` is first because
 * of the RESTRICT constraint; the rest cascade, but are listed explicitly so the
 * teardown does not depend on cascade behaviour staying as-is.
 */
const TABLES = [
  "leave_approval_steps",
  "alerts",
  "ai_audit_log",
  "leave_requests",
  "leave_balances",
  "employees",
] as const;

async function main() {
  const admin = createAdminClient();

  const { data: authUsers, error: listError } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (listError) throw new Error(`auth.admin.listUsers: ${listError.message}`);

  if (DRY_RUN) {
    console.log("DRY RUN — nothing will be deleted.\n");
    for (const table of TABLES) {
      const { count } = await admin.from(table).select("*", { count: "exact", head: true });
      console.log(`  would delete ${String(count ?? 0).padStart(4)}  ${table}`);
    }
    console.log(`  would delete ${String(authUsers.users.length).padStart(4)}  auth.users`);
    console.log(
      `\n  auth users: ${authUsers.users.map((u) => u.email ?? "(no email)").join(", ")}`,
    );
    return;
  }

  for (const table of TABLES) {
    // Count first, then delete. PostgREST does not return a dependable row count
    // for a filtered DELETE, and reporting `deleted 0` after a successful wipe
    // would be actively misleading for a destructive script.
    const { count: before, error: countError } = await admin
      .from(table)
      .select("id", { count: "exact", head: true });
    if (countError) throw new Error(`${table} (count): ${countError.message}`);

    // PostgREST refuses an unqualified DELETE, so filter on the primary key
    // being present. Every table here has a non-null `id`, so this matches all.
    const { error } = await admin.from(table).delete().not("id", "is", null);
    if (error) throw new Error(`${table} (delete): ${error.message}`);

    const { count: after } = await admin.from(table).select("id", { count: "exact", head: true });
    if ((after ?? 0) !== 0) throw new Error(`${table}: ${after} rows survived the delete`);
    console.log(`deleted ${String(before ?? 0).padStart(4)}  ${table}`);
  }

  let removedAuth = 0;
  for (const user of authUsers.users) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw new Error(`auth delete ${user.email ?? user.id}: ${error.message}`);
    removedAuth += 1;
  }
  console.log(`deleted ${String(removedAuth).padStart(4)}  auth.users`);

  console.log("\nDemo data reset complete. Schema, RLS and functions untouched.");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});