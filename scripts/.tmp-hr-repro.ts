import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { createAdminClient } from "../server/supabase/admin-core";
config({ path: ".env.local" }); config();

function future(n: number) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
// window of exactly n working days starting in `offset` days
function win(offset: number, wd: number) {
  const s = new Date(); s.setDate(s.getDate() + offset);
  while (s.getDay() === 0 || s.getDay() === 6) s.setDate(s.getDate() + 1);
  const c = new Date(s);
  for (let i = 1; i < wd;) { c.setDate(c.getDate() + 1); if (c.getDay() !== 0 && c.getDay() !== 6) i++; }
  return { start: s.toISOString().slice(0, 10), end: c.toISOString().slice(0, 10) };
}

async function main() {
  const admin = createAdminClient();
  const store = new Map<string, string>();
  const ssr = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: { getAll: () => [...store].map(([n, v]) => ({ name: n, value: v })),
      setAll: (l) => { for (const { name, value, options } of l) { if (options?.maxAge === 0) store.delete(name); else store.set(name, value); } } },
  });
  await ssr.auth.signInWithPassword({ email: "rohan.iyer@orgflow.dev", password: "OrgFlow@2026" });
  const hr = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  await hr.auth.signInWithPassword({ email: "rohan.iyer@orgflow.dev", password: "OrgFlow@2026" });

  const { data: rohan } = await admin.from("employees").select("id,name,department,app_role").eq("email", "rohan.iyer@orgflow.dev").single();
  console.log(`HR: ${rohan.name} — ${rohan.department} — ${rohan.app_role}`);

  const cases: [string, number, number][] = [["short (2 wd)", 2, 14], ["medium (5 wd)", 5, 40], ["long (10 wd)", 10, 70]];
  const created: string[] = [];
  for (const [label, wd, offset] of cases) {
    const w = win(offset, wd);
    const r = await hr.rpc("create_leave_request", { p_leave_type: "annual", p_start: w.start, p_end: w.end, p_reason: "HR repro" });
    const id = (r.data as any)?.id as string | undefined;
    created.push(id ?? "");
    const { data: req } = await admin.from("leave_requests").select("status,blocked_reason,days").eq("id", id!).maybeSingle();
    console.log(`\nHR leave ${label}  ${w.start}..${w.end} (${req?.days}d)`);
    console.log(`  status: ${req?.status}${req?.blocked_reason ? "\n  reason: " + req.blocked_reason : ""}`);
  }

  console.log("\n--- can anyone decide the blocked ones? ---");
  for (const id of created) {
    if (!id) continue;
    const { data: req } = await admin.from("leave_requests").select("status,days").eq("id", id).single();
    if (req?.status === "pending") continue;
    const selfTry = await hr.rpc("approve_leave_request", { p_request_id: id, p_comment: "self" });
    console.log(`  ${req?.status.padEnd(16)} HR self-approve -> ${JSON.stringify((selfTry.data as any)?.error_code ?? selfTry.data)}`);
  }

  for (const id of created) { if (id) await admin.from("leave_approval_steps").delete().eq("leave_request_id", id); await admin.from("leave_requests").delete().eq("id", id); }
  console.log("\n(repro fixtures removed)");
}
void main();
