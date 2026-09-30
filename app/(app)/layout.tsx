import { redirect } from "next/navigation";
import { getCurrentEmployee } from "@/server/auth";
import { groupedNavForRole, navForRole } from "@/shared/nav";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { Copilot } from "@/components/features/copilot/copilot";

/**
 * Authenticated app shell. The role is resolved from the database on every
 * request, so the navigation reflects the real `app_role` rather than anything
 * the client can influence.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const employee = await getCurrentEmployee();
  if (!employee) redirect("/login");

  // Only the fields the shell renders cross into the client bundle.
  const user = {
    name: employee.name,
    role: employee.role,
    department: employee.department,
    app_role: employee.app_role,
    photo: employee.photo,
  };

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar groups={groupedNavForRole(employee.app_role)} user={user} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar user={user} items={navForRole(employee.app_role)} />
        {/* A single reading measure: the dashboard and HR analytics need the
            full width, page content does not benefit from stretching further. */}
        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </div>

      {/* The copilot is an overlay: it never wraps or gates the page, so if it
          fails to load the app is unaffected. */}
      <Copilot />
    </div>
  );
}
