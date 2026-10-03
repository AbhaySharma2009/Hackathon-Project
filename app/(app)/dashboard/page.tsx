"use client";

import { useEmployee } from "@/components/providers/session-provider";
import { DashboardClient } from "@/components/features/dashboard/dashboard-client";


export default function DashboardPage() {
  const employee = useEmployee();

  if (!employee) return null;

  return (
    <DashboardClient
      employeeId={employee.id}
      name={employee.name}
      appRole={employee.app_role}
    />
  );
}