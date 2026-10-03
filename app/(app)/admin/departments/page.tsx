"use client";

import { useEmployee } from "@/components/providers/session-provider";
import { redirect } from "next/navigation";
import dynamic from "next/dynamic";
import { LoadingRegion } from "@/components/design/loaders";

const AdminDepartmentsClient = dynamic(
  () => import("@/components/features/admin/admin-departments-client").then((m) => m.AdminDepartmentsClient),
  {
    loading: () => <LoadingRegion label="Loading departments" />,
    ssr: false,
  },
);


export default function Page() {
  const employee = useEmployee();

  if (!employee) return null;

  if (!["admin", "super_admin"].includes(employee.app_role)) {
    redirect("/dashboard");
  }

  return <AdminDepartmentsClient />;
}