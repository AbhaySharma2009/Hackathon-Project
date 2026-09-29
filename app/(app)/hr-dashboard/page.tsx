import { redirectUnlessRole } from "@/server/auth";
import { HrDashboardClient } from "@/components/features/dashboard/hr-dashboard-client";

/**
 * HR sees organisation-wide figures; a manager sees the same dashboard scoped to
 * their own team. Employees are redirected — and the API rejects them anyway,
 * so hiding the page is a convenience rather than the control.
 */
export default async function HrDashboardPage() {
  await redirectUnlessRole("hr", "manager");

  return <HrDashboardClient />;
}
