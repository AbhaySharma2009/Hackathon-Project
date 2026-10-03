"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { groupedNavForRole, navForRole } from "@/shared/nav";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { Copilot } from "@/components/features/copilot/copilot";
import { SessionProvider, useSession } from "@/components/providers/session-provider";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Authenticated app shell. The employee is resolved from the session on the
 * client and cached in SessionContext, so navigation between pages does not
 * re-fetch the employee. The proxy middleware still protects routes at the edge.
 */
function AppLayoutInner({ children }: { children: React.ReactNode }) {
  const { employee, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !employee) {
      router.replace("/login");
    }
  }, [employee, loading, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen bg-background">
        <aside className="sticky top-0 hidden h-screen w-68 shrink-0 flex-col border-r bg-sidebar md:flex">
          <div className="flex h-16 shrink-0 items-center gap-2.5 border-b px-5">
            <Skeleton className="h-8 w-8 rounded" />
            <Skeleton className="h-5 w-24 rounded" />
          </div>
          <div className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
            <Skeleton className="h-4 w-24" />
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full rounded-lg" />
              ))}
            </div>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur-md md:px-6">
            <Skeleton className="h-10 w-10 rounded-md" />
            <nav className="min-w-0 flex-1">
              <Skeleton className="h-4 w-40" />
            </nav>
            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-6 w-20 rounded" />
              <Skeleton className="h-8 w-8 rounded-full" />
            </div>
          </header>
          <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
            <div className="mx-auto w-full max-w-7xl">
              <Skeleton className="h-8 w-48" />
              <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-24 w-full rounded-xl border" />
                ))}
              </div>
            </div>
          </main>
        </div>
      </div>
    );
  }

  if (!employee) {
    // The useEffect above will redirect, but we render null during the transition
    return null;
  }

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
        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </div>
      <Copilot />
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <AppLayoutInner>{children}</AppLayoutInner>
    </SessionProvider>
  );
}