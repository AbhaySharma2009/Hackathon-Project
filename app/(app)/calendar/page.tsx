import { redirect } from "next/navigation";
import { getCurrentEmployee } from "@/server/auth";
import { CalendarClient } from "@/components/features/calendar/calendar-client";

export const metadata = { title: "Calendar" };

export default async function CalendarPage() {
  const employee = await getCurrentEmployee();
  if (!employee) redirect("/login");

  return <CalendarClient />;
}