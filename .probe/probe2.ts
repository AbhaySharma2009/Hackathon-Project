import { config } from "dotenv";
import { createAdminClient } from "../server/supabase/admin-core";
config({ path: ".env.local" });
config();
const admin = createAdminClient();
async function main() {
  const { data: before } = await admin.from("alerts").select("id,type,scope_employee_id,message,is_read,related_date").order("created_at", { ascending: false }).limit(8);
  for (const a of before!) console.log("PRE", a.type, a.scope_employee_id, a.is_read, a.related_date, a.message);
  const a = await admin.rpc("generate_alerts");
  console.log("run1 created", a.data, a.error);
  const { data: mid } = await admin.from("alerts").select("id,type,scope_employee_id,message,is_read,related_date").order("created_at", { ascending: false }).limit(8);
  for (const x of mid!) console.log("MID", x.type, x.scope_employee_id, x.is_read, x.related_date, x.message);
  const b = await admin.rpc("generate_alerts");
  console.log("run2 created", b.data);
  const { data: after } = await admin.from("alerts").select("id,type,scope_employee_id,message,is_read,related_date").order("created_at", { ascending: false }).limit(8);
  for (const x of after!) console.log("POST", x.type, x.scope_employee_id, x.is_read, x.related_date, x.message);
}
void main();
