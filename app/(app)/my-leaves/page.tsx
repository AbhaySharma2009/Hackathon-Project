import { redirect } from "next/navigation";
import { getCurrentEmployee } from "@/server/auth";
import { MyLeavesClient } from "@/components/features/leave/my-leaves-client";

export const metadata = { title: "My Leaves" };

export default async function MyLeavesPage() {
  const employee = await getCurrentEmployee();
  if (!employee) redirect("/login");

  // The employee id comes from the session, never from the URL.
  return <MyLeavesClient employeeId={employee.id} />;
}
