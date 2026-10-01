/**
 * Creates the Phase 15 Super Admin on an already-seeded database.
 *
 * `seed-demo-data.ts` now includes this person, so a fresh seed needs nothing
 * here. This exists because the live database was seeded before Phase 15, and
 * re-running the whole seed would reset every request, balance and approval.
 * It adds exactly one account and leaves the demo data alone.
 *
 *   npm run db:seed-super-admin
 */
import { config } from "dotenv";
import { createAdminClient } from "../server/supabase/admin-core";

config({ path: ".env.local" });

const SUPER_ADMIN = {
  id: "11111111-1111-4111-8111-000000000099",
  email: "ananya.iyer@orgflow.dev",
  name: "Ananya Iyer",
  role: "Chief Operating Officer",
  department: "HR & Operations",
  join_date: "2016-02-01",
};
const DEMO_PASSWORD = "OrgFlow@2026";

async function main() {
  const db = createAdminClient();

  const { data: created, error: createError } = await db.auth.admin.createUser({
    email: SUPER_ADMIN.email,
    password: DEMO_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: SUPER_ADMIN.name, role: "super_admin" },
  });
  if (createError && !/already/i.test(createError.message)) {
    throw new Error(`auth create: ${createError.message}`);
  }

  let authUserId = created?.user?.id;

  // Already created by an earlier run — find the existing account.
  if (!authUserId) {
    const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    authUserId = list?.users?.find((u) => u.email === SUPER_ADMIN.email)?.id;
  }
  if (!authUserId) throw new Error("could not resolve a Supabase auth id for the Super Admin");

  const { data: existing } = await db
    .from("employees")
    .select("id")
    .eq("id", SUPER_ADMIN.id)
    .maybeSingle();

  if (existing) {
    await db
      .from("employees")
      .update({ auth_user_id: authUserId, app_role: "super_admin", is_active: true })
      .eq("id", SUPER_ADMIN.id);
    console.log("updated the existing Super Admin row");
  } else {
    const { error } = await db.from("employees").insert({
      id: SUPER_ADMIN.id,
      auth_user_id: authUserId,
      name: SUPER_ADMIN.name,
      email: SUPER_ADMIN.email,
      role: SUPER_ADMIN.role,
      app_role: "super_admin",
      department: SUPER_ADMIN.department,
      manager_id: null,
      join_date: SUPER_ADMIN.join_date,
      is_active: true,
    });
    if (error) throw error;
    console.log("inserted the Super Admin");
  }

  // Balances, so they can request leave like anyone else.
  const year = new Date().getFullYear();
  const { error: balanceError } = await db
    .from("leave_balances")
    .upsert(
      (
        ["casual", "sick", "annual", "unpaid"] as const
      ).map((leave_type) => ({
        employee_id: SUPER_ADMIN.id,
        year,
        leave_type,
        allocated: leave_type === "casual" ? 12 : leave_type === "sick" ? 10 : leave_type === "annual" ? 25 : 0,
        used: 0,
      })),
      { onConflict: "employee_id,year,leave_type", ignoreDuplicates: true },
    );
  if (balanceError) throw balanceError;

  // The Admin now reports to the Super Admin, which is what makes an Admin's
  // leave resolve upwards rather than parking as blocked.
  const { error: adminLink } = await db
    .from("employees")
    .update({ manager_id: SUPER_ADMIN.id })
    .eq("email", "meera.krishnan@orgflow.dev");
  if (adminLink) throw adminLink;

  console.log(`Super Admin ready: ${SUPER_ADMIN.email} / ${DEMO_PASSWORD}`);
}

void main();
