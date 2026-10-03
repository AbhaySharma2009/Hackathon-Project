"use client";

import { useEmployee } from "@/components/providers/session-provider";
import { redirect } from "next/navigation";
import dynamic from "next/dynamic";
import { LoadingRegion } from "@/components/design/loaders";

const AdminConsoleClient = dynamic(
  () => import("@/components/features/admin/admin-console-client").then((m) => m.AdminConsoleClient),
  {
    loading: () => (
      <div className="space-y-6" aria-hidden>
        <LoadingRegion label="Loading admin console" />
      </div>
    ),
    ssr: false,
  },
);


export default function AdminPage() {
  const employee = useEmployee();

  if (!employee) return null;

  if (!["admin", "super_admin"].includes(employee.app_role)) {
    redirect("/dashboard");
  }

  return <AdminConsoleClient />;
}