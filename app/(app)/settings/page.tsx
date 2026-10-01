import { redirect } from "next/navigation";
import { getCurrentEmployee } from "@/server/auth";
import { SettingsClient } from "@/components/features/settings/settings-client";

export const metadata = { title: "Settings" };

/**
 * Every signed-in role can reach this. It shows only what the session already
 * knows about the person, plus what the database will let them change about
 * their own account — never another person's record.
 */
export default async function SettingsPage() {
  const employee = await getCurrentEmployee();
  if (!employee) redirect("/login");

  return <SettingsClient employee={employee} />;
}