import { redirectUnlessRole } from "@/server/auth";
import { SuperAdminAccessClient } from "@/components/features/super-admin/super-admin-access-client";

export const metadata = { title: "Access & Escalation" };

/**
 * Who may hold which role, and who signs a Super Admin's own leave.
 *
 * The two Super-Admin-only controls: the escalation matrix and the fallback
 * approver. An Admin has no route here at all.
 */
export default async function SuperAdminAccessPage() {
  await redirectUnlessRole("super_admin");
  return <SuperAdminAccessClient />;
}