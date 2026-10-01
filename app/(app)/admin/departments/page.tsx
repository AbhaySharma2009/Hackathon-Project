import { redirectUnlessRole } from "@/server/auth";
import { AdminDepartmentsClient } from "@/components/features/admin/admin-departments-client";

/**
 * The authoritative list of departments that employees can be filed under.
 *
 * Admin only; a non-admin is redirected and the matching API refuses the request
 * regardless of what the URL says.
 */
export default async function Page() {
  await redirectUnlessRole("admin", "super_admin");
  return <AdminDepartmentsClient />;
}
