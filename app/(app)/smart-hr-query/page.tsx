import { redirectUnlessRole } from "@/server/auth";
import { PageHeader } from "@/components/design/page-header";
import { SmartHrQueryCard } from "@/components/features/dashboard/smart-hr-query-card";

export const metadata = { title: "Smart HR Query" };

/**
 * Smart HR Query on its own route.
 *
 * HR only. The gate here is a convenience: `POST /api/ai/hr-query` runs
 * `requireHr()` before anything else, and each `q_*` function repeats the check
 * inside the database, so the fixed-tool catalog is never reachable by a
 * manager or an employee no matter how the request is made.
 */
export default async function SmartHrQueryPage() {
  await redirectUnlessRole("hr", "admin", "super_admin");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Smart HR Query"
        description="Ask a workforce question in plain English and get a table back. Every answer runs one of seven fixed, role-scoped reports — the model chooses the function and its dates, and never writes the query itself."
      />
      <SmartHrQueryCard variant="page" />
    </div>
  );
}
