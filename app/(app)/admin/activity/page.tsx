"use client";

import { useEmployee } from "@/components/providers/session-provider";
import { redirect } from "next/navigation";
import dynamic from "next/dynamic";
import { LoadingRegion } from "@/components/design/loaders";

const AdminActivityClient = dynamic(
  () => import("@/components/features/admin/admin-activity-client").then((m) => m.AdminActivityClient),
  {
    loading: () => <LoadingRegion label="Loading admin activity" />,
    ssr: false,
  },
);


export default function Page() {
  const employee = useEmployee();

  if (!employee) return null;

  if (!["admin", "super_admin"].includes(employee.app_role)) {
    redirect("/dashboard");
  }

  return <AdminActivityClient />;
}