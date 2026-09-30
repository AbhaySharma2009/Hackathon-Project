/**
 * Dump every application table (plus the auth user list) to JSON.
 *
 * Insurance for `scripts/reset-demo-data.ts`: the reset is irreversible, so take a
 * restorable snapshot first. Output goes outside the repo by default because these
 * files contain seeded-but-real-looking personal data.
 *
 *   npx tsx scripts/backup-data.ts [--out <dir>]
 */
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAdminClient } from "../server/supabase/admin-core";

config({ path: ".env.local" });
config();

const TABLES = [
  "employees",
  "leave_requests",
  "leave_balances",
  "leave_approval_steps",
  "alerts",
  "ai_audit_log",
] as const;

function outDir(): string {
  const flag = process.argv.indexOf("--out");
  if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1];
  return join(homedir(), ".orgflow", "backups");
}

async function main() {
  const admin = createAdminClient();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(outDir(), stamp);
  mkdirSync(dir, { recursive: true });

  const report: Record<string, number> = {};
  for (const table of TABLES) {
    const { data, error } = await admin.from(table).select("*");
    if (error) throw new Error(`${table}: ${error.message}`);
    writeFileSync(join(dir, `${table}.json`), JSON.stringify(data, null, 2));
    report[table] = data?.length ?? 0;
  }

  const { data: users, error: userErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (userErr) throw new Error(`auth.admin.listUsers: ${userErr.message}`);
  writeFileSync(
    join(dir, "auth-users.json"),
    JSON.stringify(
      (users?.users ?? []).map((u) => ({
        id: u.id,
        email: u.email,
        email_confirmed_at: u.email_confirmed_at,
      })),
      null,
      2,
    ),
  );
  report["auth_users"] = users?.users.length ?? 0;

  writeFileSync(join(dir, "counts.json"), JSON.stringify(report, null, 2));
  console.log(`backup written to ${dir}`);
  for (const [table, count] of Object.entries(report)) console.log(`  ${count}\t${table}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});