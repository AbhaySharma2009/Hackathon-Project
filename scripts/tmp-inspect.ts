import { config } from "dotenv";
import { createAdminClient } from "../server/supabase/admin-core";

config({ path: ".env.local" });
config();

const admin = createAdminClient();

async function main() {
  const emp = await admin
    .from("employees")
    .select("id, name, email, app_role, department, manager_id, is_active")
    .order("name");
  console.log("EMPLOYEES", emp.error, "");
  console.table(emp.data);

  const bal = await admin
    .from("leave_balances")
    .select("employee_id, year, leave_type, allocated, used");
  console.log("BALANCE ROWS", bal.data?.length);
  const cur = new Date().getFullYear();
  console.table(bal.data?.filter((b) => b.year === cur));

  const req = await admin
    .from("leave_requests")
    .select("id, employee_id, leave_type, start_date, end_date, days, status")
    .order("start_date");
  console.log("REQUESTS", req.data?.length);
  console.table(req.data);

  const pol = await admin.from("approval_policy").select("*").single();
  console.log("POLICY", pol.data);

  const steps = await admin.from("leave_approval_steps").select("leave_request_id, level, approver_role, status");
  console.log("STEPS", steps.data?.length);
  console.table(steps.data);
}

main();