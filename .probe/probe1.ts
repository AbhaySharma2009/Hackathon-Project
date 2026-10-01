import { config } from "dotenv";
import { createAdminClient } from "../server/supabase/admin-core";
config({ path: ".env.local" });
config();
const admin = createAdminClient();
async function main() {
  const { data: emps } = await admin.from("employees").select("id,name,email,app_role,department,manager_id,is_active");
  console.log("EMPLOYEES");
  for (const e of emps!) console.log(" ", e.id, e.name, e.email, e.app_role, e.department, "mgr:", e.manager_id);
  const { data: lr } = await admin.from("leave_requests").select("id,employee_id,leave_type,start_date,end_date,days,status,reason").order("start_date");
  console.log("LEAVE REQUESTS", lr!.length);
  for (const r of lr!) console.log(" ", r.id, r.employee_id, r.leave_type, r.start_date, r.end_date, r.days, r.status, JSON.stringify(r.reason).slice(0,40));
  const year = new Date().getFullYear();
  const { data: bal } = await admin.from("leave_balances").select("employee_id,leave_type,allocated,used,year").eq("year", year);
  console.log("BALANCES", year);
  for (const b of bal!) console.log(" ", b.employee_id, b.leave_type, "alloc", b.allocated, "used", b.used);
  const { count } = await admin.from("alerts").select("*", { count: "exact", head: true });
  console.log("ALERTS", count);
}
void main();
