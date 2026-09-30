import { redirectUnlessRole } from "@/server/auth";
import { HrDashboardClient } from "@/components/features/dashboard/hr-dashboard-client";

/**
 * HR sees organisation-wide figures; a manager sees the same dashboard scoped to
 * their own team. Employees are redirected — and the API rejects them anyway,
 * so hiding the page is a convenience rather than the control.
 */
export default async function HrDashboardPage() {
  const employee = await redirectUnlessRole("hr", "manager");

  // The role travels down so the page can hide the HR-only Smart HR Query card
  // from a manager. Hiding it is a convenience; POST /api/ai/hr-query rejects a
  // non-HR session with FORBIDDEN before the model is ever called, and each
  // `q_*` function repeats the check in the database.
  return <HrDashboardClient appRole={employee.app_role} />;
}
