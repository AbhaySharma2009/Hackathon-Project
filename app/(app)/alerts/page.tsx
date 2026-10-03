"use client";

import { useEmployee } from "@/components/providers/session-provider";
import dynamic from "next/dynamic";
import { LoadingRegion } from "@/components/design/loaders";
import { PageHeader } from "@/components/design/page-header";

const AlertList = dynamic(
  () => import("@/components/features/alerts/alert-list").then((m) => m.AlertList),
  {
    loading: () => (
      <div className="space-y-6" aria-hidden>
        <LoadingRegion label="Loading alerts" />
        <PageHeader title="Alerts" />
      </div>
    ),
    ssr: false,
  },
);


export default function AlertsPage() {
  const employee = useEmployee();

  if (!employee) return null;

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