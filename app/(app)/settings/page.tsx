import { redirect } from "next/navigation";
import { getCurrentEmployee } from "@/server/auth";
import { createClient } from "@/server/supabase/server";
import { ProfileClient } from "@/components/features/profile/profile-client";
import type { AppRole } from "@/shared/types";

export const metadata = { title: "Profile" };

/**
 * The profile page, reachable by every role.
 *
 * The page reads the caller's own row and nothing else — it never takes an id in
 * the URL and never accepts a query parameter. That is deliberate: the only
 * profile this route can show is the signed-in person's, so there is no path by
 * which it could be pointed at somebody else's record.
 *
 * `manageProfile` is read from the server so the page can tell the reader which
 * organisation fields to expect to be locked. It is not a permission: the
 * database decides what can be written, and `update_my_profile` has no
 * parameter for any of those fields.
 */
export default async function ProfilePage() {
  const employee = await getCurrentEmployee();
  if (!employee) redirect("/login");

  const supabase = await createClient();

  // `email` and `app_role` are not granted to `authenticated` as direct column
  // privileges on `employees`, so they come through the SECURITY DEFINER
  // `get_employee_detail`, which returns the whole row minus `auth_user_id` for
  // the caller. Reading them straight from the table would fail on permissions.
  const { data: detail } = await supabase.rpc("get_employee_detail", {
    p_employee_id: employee.id,
  });

  if (!detail) redirect("/login");

  const data = detail as unknown as {
    id: string;
    name: string;
    email: string;
    photo: string | null;
    phone?: string | null;
    personal_email?: string | null;
    address?: string | null;
    emergency_contact_name?: string | null;
    emergency_contact_phone?: string | null;
    app_role: AppRole;
    role: string;
    department: string;
    manager_id: string | null;
    join_date: string;
    is_active: boolean;
  };

  let managerName: string | null = null;
  if (data.manager_id) {
    const { data: manager } = await supabase
      .from("employees")
      .select("name")
      .eq("id", data.manager_id)
      .maybeSingle();
    managerName = manager?.name ?? null;
  }

  const { data: balances } = await supabase
    .from("leave_balances")
    .select("leave_type, allocated, used")
    .eq("employee_id", employee.id)
    .eq("year", new Date().getFullYear())
    .order("leave_type");

  return (
    <ProfileClient
      personal={{
        name: data.name,
        photo: data.photo,
        phone: data.phone ?? null,
        personal_email: data.personal_email ?? null,
        address: data.address ?? null,
        emergency_contact_name: data.emergency_contact_name ?? null,
        emergency_contact_phone: data.emergency_contact_phone ?? null,
      }}
      organisation={{
        employee_id: data.id,
        work_email: data.email,
        app_role: data.app_role,
        designation: data.role,
        department: data.department,
        manager_name: managerName,
        joining_date: data.join_date,
        account_status: data.is_active ? "active" : "inactive",
      }}
      balances={(balances ?? []).map((b) => ({
        leave_type: b.leave_type,
        allocated: b.allocated,
        used: b.used,
        remaining: b.allocated - b.used,
      }))}
    />
  );
}