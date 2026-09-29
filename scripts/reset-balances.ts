/**
 * Restores `leave_balances` to the state `supabase/seed.sql` produces.
 *
 * Approving a leave request permanently spends a balance — that is rule 2, and it
 * is not something a test should undo by deleting rows. So a run that is killed
 * part-way through can leave the ledger drifted, and later runs then fail against
 * the wrong numbers (or, worse, pass for the wrong reason).
 *
 * Run this after an interrupted run, or whenever a test is added that approves
 * leave and does not restore the balance itself:
 *
 *   npm run db:reset-balances
 *
 * Requires a Supabase management token in SUPABASE_ACCESS_TOKEN or at
 * ~/.supabase/access-token, because it runs SQL with owner rights.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? "rievmffkvabkhmjdmqif";

function token(): string {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  return readFileSync(join(homedir(), ".supabase", "access-token"), "utf8").trim();
}

const sql = readFileSync("supabase/reset-balances.sql", "utf8");

async function main() {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    },
  );

  const result = (await response.json()) as { error?: string }[];

  if (!response.ok || result[0]?.error) {
    console.error("Failed to reset balances:", result[0]?.error ?? await response.text());
    process.exit(1);
  }

  console.log("Balances restored to the seeded state.");
}

main();
