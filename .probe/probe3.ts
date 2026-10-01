import { config } from "dotenv";
import { createServerClient } from "@supabase/ssr";
config({ path: ".env.local" });
config();
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
async function cookieFor(email: string) {
  const store = new Map<string, string>();
  const ssr = createServerClient(URL, ANON, {
    cookies: {
      getAll: () => [...store].map(([name, value]) => ({ name, value })),
      setAll: (list) => { for (const { name, value, options } of list) { if (options?.maxAge === 0) store.delete(name); else store.set(name, value); } },
    },
  });
  const { error } = await ssr.auth.signInWithPassword({ email, password: "OrgFlow@2026" });
  if (error) throw error;
  return [...store].map(([name, value]) => `${name}=${value}`).join("; ");
}
async function main() {
  const cookie = await cookieFor("rohan.iyer@orgflow.dev");
  const get = await fetch("http://localhost:3000/api/alerts", { headers: { Cookie: cookie } });
  const body: any = await get.json();
  console.log("GET", get.status, "alerts", body.data.alerts.length, "unread", body.data.unread_count);
  const target = body.data.alerts.find((a: any) => !a.is_read);
  console.log("target", JSON.stringify(target));
  const patch = await fetch(`http://localhost:3000/api/alerts/${target.id}`, {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ is_read: true }),
  });
  console.log("PATCH", patch.status, JSON.stringify(await patch.json()));
}
void main();
