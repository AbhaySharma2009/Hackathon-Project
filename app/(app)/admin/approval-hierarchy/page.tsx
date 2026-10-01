import { redirectUnlessRole } from "@/server/auth";
import { AdminApprovalHierarchyClient } from "@/components/features/admin/admin-approval-hierarchy-client";

/**
 * How many approvers a request of a given length needs, and the thresholds behind it.
 *
 * Admin only; a non-admin is redirected and the matching API refuses the request
 * regardless of what the URL says.
 */
export default async function Page() {
  await redirectUnlessRole("admin", "super_admin");
  return <AdminApprovalHierarchyClient />;
}
