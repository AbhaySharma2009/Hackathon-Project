import { redirect } from "next/navigation";
import { getCurrentEmployee } from "@/server/auth";
import { DashboardClient } from "@/components/features/dashboard/dashboard-client";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const employee = await getCurrentEmployee();
  if (!employee) redirect("/login");

  // The dashboard is built entirely from the endpoints this person already owns:
  // their own balances and requests, plus their own approval inbox for the two
  // leadership roles. No new query and no widened scope was introduced here.
  return (
    <DashboardClient
      employeeId={employee.id}
      name={employee.name}
      appRole={employee.app_role}
    />
  );
}
