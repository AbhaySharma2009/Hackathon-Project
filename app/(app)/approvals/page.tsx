import { redirectUnlessRole } from "@/server/auth";
import { ApprovalsClient } from "@/components/features/approvals/approvals-client";

export const metadata = { title: "Approvals" };

export default async function ApprovalsPage() {
  // Server-side role check: reaching this route as an employee redirects, even
  // if the link is crafted by hand. RLS blocks the data either way.
  await redirectUnlessRole("manager", "hr");

  return <ApprovalsClient />;
}
