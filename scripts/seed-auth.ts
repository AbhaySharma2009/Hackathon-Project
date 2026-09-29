/**
 * Creates the three demo auth users and links them to their `employees` rows.
 *
 *   npm run seed:auth
 *
 * Safe to re-run: existing users are located by email and their password is
 * reset to the demo value, and the employees.auth_user_id link is re-applied.
 * Requires SUPABASE_SERVICE_ROLE_KEY (server-side only — never in the browser).
 */
import { config } from "dotenv";
import { createAdminClient } from "../server/supabase/admin-core";

// Next.js reads .env.local; plain Node does not, so point dotenv at it directly.
config({ path: ".env.local" });
config();

const DEMO_PASSWORD = "OrgFlow@2026";

const DEMO_USERS = [
  { email: "neha.gupta@orgflow.dev", role: "employee" as const },
  { email: "sanjay.kapoor@orgflow.dev", role: "manager" as const },
  { email: "vikram.sethi@orgflow.dev", role: "manager" as const },
  { email: "rohan.iyer@orgflow.dev", role: "hr" as const },
];

async function main() {
  const supabase = createAdminClient();
  const credentials: { email: string; role: string; password: string }[] = [];

  for (const demo of DEMO_USERS) {
    // 1. Find or create the auth user.
    const { data: created, error: createError } =
      await supabase.auth.admin.createUser({
        email: demo.email,
        password: DEMO_PASSWORD,
        email_confirm: true,
      });

    let userId = created.user?.id ?? null;
    let user = created.user ?? null;

    if (createError) {
      // Already exists is the expected case on a re-run.
      const { data: list, error: listError } = await supabase.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });
      if (listError) throw listError;
      user = list.users.find((u) => u.email === demo.email) ?? null;
      userId = user?.id ?? null;

      if (!userId) throw createError;

      const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
        password: DEMO_PASSWORD,
        email_confirm: true,
      });
      if (updateError) throw updateError;
    }

    if (!userId) throw new Error(`Could not resolve auth user for ${demo.email}`);

    // 2. Link the auth user to the employee row created by the seed.
    const { error: linkError } = await supabase
      .from("employees")
      .update({ auth_user_id: userId })
      .eq("email", demo.email);

    if (linkError) throw linkError;

    const { data: employee } = await supabase
      .from("employees")
      .select("name, app_role")
      .eq("email", demo.email)
      .single();

    if (employee?.app_role !== demo.role) {
      throw new Error(
        `Seed mismatch: ${demo.email} has app_role '${employee?.app_role}', expected '${demo.role}'`,
      );
    }

    credentials.push({ email: demo.email, role: demo.role, password: DEMO_PASSWORD });
  }

  console.log("\nDemo accounts ready — sign in at /login\n");
  for (const cred of credentials) {
    console.log(`  ${cred.role.padEnd(8)}  ${cred.email}  /  ${cred.password}`);
  }
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
