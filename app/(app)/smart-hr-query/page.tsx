"use client";

import { useEmployee } from "@/components/providers/session-provider";
import { redirect } from "next/navigation";
import dynamic from "next/dynamic";
import { LoadingRegion } from "@/components/design/loaders";
import { PageHeader } from "@/components/design/page-header";

const SmartHrQueryCard = dynamic(
  () => import("@/components/features/dashboard/smart-hr-query-card").then((m) => m.SmartHrQueryCard),
  {
    loading: () => (
      <div className="space-y-6" aria-hidden>
        <LoadingRegion label="Loading Smart HR Query" />
        <PageHeader
          title="Smart HR Query"
          description="Ask a workforce question in plain English and get a table back."
        />
      </div>
    ),
    ssr: false,
  },
);


export default function SmartHrQueryPage() {
  const employee = useEmployee();

  if (!employee) return null;

  if (!["hr", "admin", "super_admin"].includes(employee.app_role)) {
    redirect("/dashboard");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Smart HR Query"
        description="Ask a workforce question in plain English and get a table back. Every answer runs one of seven fixed, role-scoped reports — the model chooses the function and its dates, and never writes the query itself."
      />
      <SmartHrQueryCard variant="page" />
    </div>
  );
}