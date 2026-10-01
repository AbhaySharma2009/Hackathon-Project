import { config } from "dotenv";
import { createAdminClient } from "../server/supabase/admin-core";

config({ path: ".env.local" });
config();

const admin = createAdminClient();

async function main() {
  const req = await admin
    .from("leave_requests")
    .select("id, employee_id, leave_type, start_date, end_date, days, status")
    .order("start_date");
  const emp = await admin.from("employees").select("id, email");
  const byId = new Map(emp.data!.map((e) => [e.id, e.email]));
  console.table(
    (req.data ?? []).map((r) => ({
      seed: r.id.startsWith("11111111-") ? "seed" : "STRAY",
      who: byId.get(r.employee_id),
      type: r.leave_type,
      start: r.start_date,
      end: r.end_date,
      days: r.days,
      status: r.status,
      id: r.id,
    })),
  );
}

main();