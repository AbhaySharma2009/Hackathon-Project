import { redirect } from "next/navigation";
import { getCurrentEmployee } from "@/lib/auth";
import { DirectoryClient } from "@/components/directory/directory-client";

export const metadata = { title: "Directory" };

export default async function DirectoryPage() {
  const employee = await getCurrentEmployee();
  if (!employee) redirect("/login");

  // The role flag only decides which buttons render. The API rejects an
  // unauthorised call with FORBIDDEN regardless of what the client sends.
  return <DirectoryClient isHr={employee.app_role === "hr"} selfId={employee.id} />;
}
