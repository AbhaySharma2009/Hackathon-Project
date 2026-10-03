"use client";

import { useEmployee } from "@/components/providers/session-provider";
import { redirect } from "next/navigation";
import dynamic from "next/dynamic";
import { LoadingRegion } from "@/components/design/loaders";

const AdminUsersClient = dynamic(
  () => import("@/components/features/admin/admin-users-client").then((m) => m.AdminUsersClient),
  {
    loading: () => <LoadingRegion label="Loading users" />,
    ssr: false,
  },
);


export default function Page() {
  const employee = useEmployee();

  if (!employee) return null;

  if (!["admin", "super_admin"].includes(employee.app_role)) {
    redirect("/dashboard");
  }

  return <AdminUsersClient />;
}