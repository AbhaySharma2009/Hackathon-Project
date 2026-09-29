import { redirect } from "next/navigation";
import { getCurrentEmployee } from "@/server/auth";
import { OrgChartClient } from "@/components/features/org-chart/org-chart-client";

export const metadata = { title: "Org Chart" };

export default async function OrgChartPage() {
  const employee = await getCurrentEmployee();
  if (!employee) redirect("/login");

  return <OrgChartClient />;
}