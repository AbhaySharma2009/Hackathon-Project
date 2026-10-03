"use client";

import { useEmployee } from "@/components/providers/session-provider";
import dynamic from "next/dynamic";
import { LoadingRegion, KpiSkeleton } from "@/components/design/loaders";

const ProfileClient = dynamic(
  () => import("@/components/features/profile/profile-client").then((m) => m.ProfileClient),
  {
    loading: () => (
      <div className="mx-auto w-full max-w-3xl space-y-6" aria-hidden>
        <LoadingRegion label="Loading profile" />
        <KpiSkeleton />
        <KpiSkeleton />
        <KpiSkeleton />
        <KpiSkeleton />
      </div>
    ),
    ssr: false,
  },
);


export default function ProfilePage() {
  const employee = useEmployee();

  if (!employee) return null;

  return <ProfileClient employeeId={employee.id} />;
}