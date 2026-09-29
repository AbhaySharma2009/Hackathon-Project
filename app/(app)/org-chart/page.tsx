import { redirect } from "next/navigation";
import { getCurrentEmployee } from "@/lib/auth";
import { OrgChartClient } from "@/components/org-chart/org-chart-client";

export const metadata = { title: "Org Chart" };

export default async function OrgChartPage() {
  const employee = await getCurrentEmployee();
  if (!employee) redirect("/login");

  return <OrgChartClient />;
}