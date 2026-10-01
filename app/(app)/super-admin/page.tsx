import { redirectUnlessRole } from "@/server/auth";
import { SuperAdminConsoleClient } from "@/components/features/super-admin/super-admin-console-client";

export const metadata = { title: "Super Admin Console" };

/**
 * The Super Admin landing page.
 *
 * Super Admin only — narrower than `/admin`, which an Admin may reach. A
 * Super Admin is also admitted, since the top tier may do everything an Admin
 * may.
 *
 * `redirectUnlessRole` is a routing convenience, not the control: the page's
 * `/api/super-admin/*` routes repeat the check, and the RPCs behind them call
 * `assert_super_admin_actor`, so a hand-typed URL gains nothing.
 */
export default async function SuperAdminPage() {
  await redirectUnlessRole("super_admin");
  return <SuperAdminConsoleClient />;
}