import { redirect } from "next/navigation";
import { getCurrentEmployee } from "@/server/auth";
import { homeForRole } from "@/shared/nav";

/**
 * Entry point: the proxy has already guaranteed a session before we get here.
 *
 * The destination is the caller's own portal. This used to be a hard-coded
 * `/dashboard`, which quietly dropped an Admin or a Super Admin into the employee
 * view on every fresh sign-in — the role-aware redirect in the sign-in action
 * was correct, but any request to `/` bypassed it.
 */
export default async function HomePage() {
  const employee = await getCurrentEmployee();
  redirect(employee ? homeForRole(employee.app_role) : "/login");
}