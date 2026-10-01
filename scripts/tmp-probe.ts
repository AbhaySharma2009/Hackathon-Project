import { config } from "dotenv";
import { signIn, PEOPLE, createAdminClient } from "../tests/fixtures";

config({ path: ".env.local" });
config();

async function main() {
  const admin = createAdminClient();
  const aditya = await signIn(PEOPLE.ceo);
  const sanjay = await signIn(PEOPLE.engManager);
  const vikram = await signIn(PEOPLE.salesManager);

  const emp = await admin.from("employees").select("id, name, email, app_role, manager_id");
  console.table(emp.data);

  const sanjayId = emp.data!.find((e) => e.email === PEOPLE.engManager)!.id;
  const nehaId = emp.data!.find((e) => e.email === PEOPLE.neha)!.id;
  const priyaId = emp.data!.find((e) => e.email === PEOPLE.priya)!.id;

  const req = await admin
    .from("leave_requests")
    .select("id, employee_id, status, start_date, end_date, days")
    .eq("employee_id", sanjayId)
    .eq("status", "pending");
  console.log("sanjay pending", req.data);

  const target = req.data![0];
  const upd = await aditya
    .from("leave_requests")
    .update({ status: "approved" })
    .eq("id", target.id)
    .select("id, status");
  console.log("aditya direct update:", upd.error, upd.data);

  const sel = await aditya.from("leave_requests").select("employee_id");
  console.log("aditya visible employees:", [...new Set((sel.data ?? []).map((r) => r.employee_id))]);

  const sel2 = await sanjay.from("leave_requests").select("employee_id");
  console.log("sanjay visible employees:", [...new Set((sel2.data ?? []).map((r) => r.employee_id))]);

  const sel3 = await vikram.from("leave_requests").select("employee_id");
  console.log("vikram visible employees:", [...new Set((sel3.data ?? []).map((r) => r.employee_id))]);

  console.log("aditya is_manager_of sanjay", (await aditya.rpc("is_manager_of", { p_employee_id: sanjayId })).data);
  console.log("aditya is_manager_of neha", (await aditya.rpc("is_manager_of", { p_employee_id: nehaId })).data);
  console.log("sanjay is_manager_of neha", (await sanjay.rpc("is_manager_of", { p_employee_id: nehaId })).data);
  console.log("sanjay is_manager_of priya", (await sanjay.rpc("is_manager_of", { p_employee_id: priyaId })).data);

  // hr balances count
  const rohan = await signIn(PEOPLE.hr);
  const bal = await rohan.from("leave_balances").select("id");
  console.log("hr balances rows", bal.data?.length, bal.error);

  // employee column grant probes
  const neha = await signIn(PEOPLE.neha);
  console.log("select *", (await neha.from("employees").select("*").limit(1)).error?.message);
  console.log("select email", (await neha.from("employees").select("email").limit(1)).error?.message);
  console.log("select app_role", (await neha.from("employees").select("app_role").limit(1)).error?.message);
}

main();