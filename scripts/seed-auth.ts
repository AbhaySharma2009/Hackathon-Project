/**
 * Creates a demo auth user for every active employee and links it to their
 * `employees` row.
 *
 *   npm run seed:auth
 *
 * Safe to re-run: existing users are located by email and their password is
 * reset to the demo value, and the employees.auth_user_id link is re-applied.
 * Requires SUPABASE_SERVICE_ROLE_KEY (server-side only — never in the browser).
 *
 * The list is derived from the employees table rather than hard-coded, because
 * hierarchical approval hands signatures to people further up the reporting line
 * (a department head is frequently NOT the direct manager) and every one of them
 * has to be able to sign in to act on their step.
 */
import { config } from "dotenv";
import { createAdminClient } from "../server/supabase/admin-core";

// Next.js reads .env.local; plain Node does not, so point dotenv at it directly.
config({ path: ".env.local" });
config();

const DEMO_PASSWORD = "OrgFlow@2026";

type DemoUser = { email: string; role: "employee" | "manager" | "hr" };

async function main() {
  const supabase = createAdminClient();

  const { data: staff, error: staffError } = await supabase
    .from("employees")
    .select("email, app_role")
    .eq("is_active", true)
    .order("app_role");

  if (staffError) throw staffError;

  const DEMO_USERS: DemoUser[] = (staff ?? []).map((e) => ({
    email: e.email,
    role: e.app_role as DemoUser["role"],
  }));

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
