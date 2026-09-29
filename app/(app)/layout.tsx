import { redirect } from "next/navigation";
import { getCurrentEmployee } from "@/server/auth";
import { navForRole } from "@/shared/nav";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";

/**
 * Authenticated app shell. The role is resolved from the database on every
 * request, so the sidebar reflects the real `app_role` rather than anything the
 * client can influence.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const employee = await getCurrentEmployee();
  if (!employee) redirect("/login");

  return (
    <div className="flex min-h-screen bg-muted/30">
      <Sidebar items={navForRole(employee.app_role)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar employee={employee} />
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
