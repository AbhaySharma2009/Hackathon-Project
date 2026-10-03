"use client";

import { useEmployee } from "@/components/providers/session-provider";
import { redirect } from "next/navigation";
import dynamic from "next/dynamic";
import { LoadingRegion } from "@/components/design/loaders";

const SuperAdminConsoleClient = dynamic(
  () => import("@/components/features/super-admin/super-admin-console-client").then((m) => m.SuperAdminConsoleClient),
  {
    loading: () => <LoadingRegion label="Loading super admin console" />,
    ssr: false,
  },
);


export default function SuperAdminPage() {
  const employee = useEmployee();

  if (!employee) return null;

  if (employee.app_role !== "super_admin") {
    redirect("/dashboard");
  }

  return <SuperAdminConsoleClient />;
}