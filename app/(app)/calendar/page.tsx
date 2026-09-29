import { redirect } from "next/navigation";
import { getCurrentEmployee } from "@/lib/auth";
import { CalendarClient } from "@/components/calendar/calendar-client";

export const metadata = { title: "Calendar" };

export default async function CalendarPage() {
  const employee = await getCurrentEmployee();
  if (!employee) redirect("/login");

  return <CalendarClient />;
}