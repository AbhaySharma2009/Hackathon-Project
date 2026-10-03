"use client";

import { useEmployee } from "@/components/providers/session-provider";
import dynamic from "next/dynamic";
import { LoadingRegion, ListSkeleton, KpiSkeleton } from "@/components/design/loaders";

const MyLeavesClient = dynamic(
  () => import("@/components/features/leave/my-leaves-client").then((m) => m.MyLeavesClient),
  {
    loading: () => (
      <div className="space-y-8" aria-hidden>
        <LoadingRegion label="Loading your leave" />
        <KpiSkeleton />
        <KpiSkeleton />
        <ListSkeleton count={3} />
      </div>
    ),
    ssr: false,
  },
);


export default function MyLeavesPage() {
  const employee = useEmployee();

  if (!employee) return null;

  return <MyLeavesClient employeeId={employee.id} />;
}