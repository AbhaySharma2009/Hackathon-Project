import { redirectUnlessRole } from "@/server/auth";
import { AdminConsoleClient } from "@/components/features/admin/admin-console-client";

/**
 * The administrator landing page.
 *
 * Admin only. A signed-in non-admin is redirected rather than shown an empty
 * page, and every `/api/admin/*` route rejects them independently.
 */
export default async function AdminPage() {
  await redirectUnlessRole("admin");
  return <AdminConsoleClient />;
}
