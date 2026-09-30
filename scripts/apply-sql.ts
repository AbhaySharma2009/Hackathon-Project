/**
 * Apply a .sql file to the linked Supabase project.
 *
 * This project manages its schema with raw SQL migrations applied by hand, and
 * has no `supabase/config.toml`, so there is no local migration runner. This
 * posts a file to the project's Management API query endpoint using the same
 * credentials as `scripts/reset-balances.ts`, which is the established path here.
 *
 * Use it for a targeted fix or a re-apply of one migration. It never touches
 * `.env.local`.
 *
 *   npx tsx scripts/apply-sql.ts supabase/migrations/0007_insights.sql
 *   npx tsx scripts/apply-sql.ts --file <path> --create-function-only
 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

config({ path: ".env.local" });
config();

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? "rievmffkvabkhmjdmqif";

function token(): string {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  return readFileSync(join(homedir(), ".supabase", "access-token"), "utf8").trim();
}

function targetPath(): string {
  const fileFlag = process.argv.indexOf("--file");
  if (fileFlag !== -1 && process.argv[fileFlag + 1]) return process.argv[fileFlag + 1];
  const positional = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!positional) {
    console.error("usage: tsx scripts/apply-sql.ts <path.sql> | --file <path.sql>");
    process.exit(1);
  }
  return positional;
}

async function main() {
  const path = targetPath();
  const sql = readFileSync(path, "utf8");
  console.log(`applying ${path} (${sql.length} bytes) to project ${PROJECT_REF}…`);

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

  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    console.error(`failed (${response.status}):`);
    console.error(typeof body === "string" ? body : JSON.stringify(body, null, 2));
    process.exit(1);
  }
  console.log("applied cleanly");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
