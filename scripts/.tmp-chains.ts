import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "../server/supabase/admin-core";
config({ path: ".env.local" }); config();
function win(offset: number, wd: number) {
  const s = new Date(); s.setDate(s.getDate() + offset);
  while (s.getDay() === 0 || s.getDay() === 6) s.setDate(s.getDate() + 1);
  const c = new Date(s);
  for (let i = 1; i < wd;) { c.setDate(c.getDate() + 1); if (c.getDay() !== 0 && c.getDay() !== 6) i++; }
  return { start: s.toISOString().slice(0, 10), end: c.toISOString().slice(0, 10) };
}
async function main() {
  const admin = createAdminClient();
  const { data: emps } = await admin.from("employees").select("id,name,email,app_role,department");
  const byId = new Map((emps ?? []).map(e => [e.id, e]));
  const mk = async (email: string) => {
    const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    await c.auth.signInWithPassword({ email, password: "OrgFlow@2026" });
    return c;
  };
  const hr = await mk("rohan.iyer@orgflow.dev");
  const neha = await mk("neha.gupta@orgflow.dev");
  const made: string[] = [];

  const show = async (label: string, r: any, id?: string) => {
    if (!id) { console.log(`\n${label}: NOT CREATED ${JSON.stringify(r)}`); return; }
    const { data: req } = await admin.from("leave_requests").select("status,days,blocked_reason").eq("id", id).single();
    const { data: steps } = await admin.from("leave_approval_steps").select("level,status,approver_employee_id,approver_role").eq("leave_request_id", id).order("level");
    console.log(`\n${label}  -> ${req?.status} (${req?.days}d)${req?.blocked_reason ? " reason: " + req.blocked_reason : ""}`);
    for (const s of steps ?? []) {
      const who = byId.get(s.approver_employee_id)?.name ?? "?";
      const self = s.approver_employee_id === byId.get((await admin.from("leave_requests").select("employee_id").eq("id", id).single()).data!.employee_id);
      console.log(`   L${s.level} ${s.status.padEnd(8)} ${s.approver_role.padEnd(16)} ${who}${self ? "   <<< SELF-APPROVAL BUG" : ""}`);
    }
  };

  for (const [lbl, off, wd] of [["HR  short 2d", 14, 2], ["HR  medium 5d", 40, 5], ["HR  long 10d", 70, 10]] as [string, number, number][]) {
    const w = win(off, wd);
    const r = await hr.rpc("create_leave_request", { p_leave_type: "annual", p_start: w.start, p_end: w.end, p_reason: "chain check" });
    const id = (r.data as any)?.id; if (id) made.push(id);
    await show(lbl, r, id);
  }
  // employee long leave, for contrast
  {
    const w = win(100, 10);
    const r = await neha.rpc("create_leave_request", { p_leave_type: "annual", p_start: w.start, p_end: w.end, p_reason: "chain check" });
    const id = (r.data as any)?.id; if (id) made.push(id);
    await show("EMP long 10d (unchanged behaviour)", r, id);
  }
  for (const id of made) { await admin.from("leave_approval_steps").delete().eq("leave_request_id", id); await admin.from("leave_requests").delete().eq("id", id); }
  console.log("\n(cleaned up)");
}
void main();
