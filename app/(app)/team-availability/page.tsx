"use client";

import { useEmployee } from "@/components/providers/session-provider";
import { redirect } from "next/navigation";
import dynamic from "next/dynamic";
import { LoadingRegion } from "@/components/design/loaders";

const AvailabilityClient = dynamic(
  () => import("@/components/features/availability/availability-client").then((m) => m.AvailabilityClient),
  {
    loading: () => (
      <div className="space-y-6" aria-hidden>
        <LoadingRegion label="Loading team availability" />
      </div>
    ),
    ssr: false,
  },
);


export default function TeamAvailabilityPage() {
  const employee = useEmployee();

  if (!employee) return null;

  if (!["manager", "hr", "admin", "super_admin"].includes(employee.app_role)) {
    redirect("/dashboard");
  }

  return <AvailabilityClient />;
}