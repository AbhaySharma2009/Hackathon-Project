import { redirectUnlessRole } from "@/server/auth";
import { AdminActivityClient } from "@/components/features/admin/admin-activity-client";

/**
 * Live workflow totals and every AI query the system has answered.
 *
 * Admin only; a non-admin is redirected and the matching API refuses the request
 * regardless of what the URL says.
 */
export default async function Page() {
  await redirectUnlessRole("admin", "super_admin");
  return <AdminActivityClient />;
}
