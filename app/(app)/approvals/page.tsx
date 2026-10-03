"use client";

import { useEmployee } from "@/components/providers/session-provider";
import { redirect } from "next/navigation";
import dynamic from "next/dynamic";
import { LoadingRegion, ListSkeleton } from "@/components/design/loaders";

const ApprovalsClient = dynamic(
  () => import("@/components/features/approvals/approvals-client").then((m) => m.ApprovalsClient),
  {
    loading: () => (
      <div className="space-y-6" aria-hidden>
        <LoadingRegion label="Loading approvals" />
        <ListSkeleton count={3} />
      </div>
    ),
    ssr: false,
  },
);


export default function ApprovalsPage() {
  const employee = useEmployee();

  if (!employee) return null;

  if (!["manager", "hr", "admin", "super_admin"].includes(employee.app_role)) {
    redirect("/dashboard");
  }

  return <ApprovalsClient />;
}