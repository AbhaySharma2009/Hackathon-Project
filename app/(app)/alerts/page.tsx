import { redirectUnlessRole } from "@/server/auth";
import { PageHeader } from "@/components/design/page-header";
import { AlertList } from "@/components/features/alerts/alert-list";

export const metadata = { title: "Alerts" };

/**
 * The alert queue for managers and HR.
 *
 * The same feed is behind the notification bell in the topbar, which stays
 * available to every role — this page is the full, filterable list. `/api/alerts`
 * uses `requireSession` and RLS decides the contents, so neither the page gate
 * nor this route widens what anyone sees.
 */
export default async function AlertsPage() {
  await redirectUnlessRole("manager", "hr", "admin", "super_admin");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Alerts"
        description="Coverage gaps, expiring balances and approvals that are waiting on a decision. Raised by the rule checks; scoped to you by RLS."
      />
      <AlertList />
    </div>
  );
}
