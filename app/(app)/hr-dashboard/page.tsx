"use client";

import { useEmployee } from "@/components/providers/session-provider";
import { redirect } from "next/navigation";
import dynamic from "next/dynamic";
import { LoadingRegion, KpiSkeleton } from "@/components/design/loaders";

const HrDashboardClient = dynamic(
  () => import("@/components/features/dashboard/hr-dashboard-client").then((m) => m.HrDashboardClient),
  {
    loading: () => (
      <div className="space-y-8" aria-hidden>
        <LoadingRegion label="Loading HR analytics" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <KpiSkeleton key={i} />
          ))}
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <KpiSkeleton count={4} />
          </div>
          <div className="space-y-4">
            <KpiSkeleton count={4} />
          </div>
        </div>
      </div>
    ),
    ssr: false,
  },
);


export default function HrDashboardPage() {
  const employee = useEmployee();

  if (!employee) return null;

  if (!["hr", "admin", "super_admin"].includes(employee.app_role)) {
    redirect("/dashboard");
  }

  return <HrDashboardClient appRole={employee.app_role} />;
}