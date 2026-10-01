import { redirectUnlessRole } from "@/server/auth";
import { AdminUsersClient } from "@/components/features/admin/admin-users-client";

/**
 * Change who holds which role, where they sit and who they report to.
 *
 * Admin only; a non-admin is redirected and the matching API refuses the request
 * regardless of what the URL says.
 */
export default async function Page() {
  await redirectUnlessRole("admin");
  return <AdminUsersClient />;
}
