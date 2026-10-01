"use client";

import { useCallback } from "react";
import Link from "next/link";
import { Activity, Building2, GitBranch, ShieldCheck, Users } from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/design/page-header";
import { ErrorState } from "@/components/design/states";
import { KpiSkeleton } from "@/components/design/loaders";
import { ToastViewport, useToast } from "@/components/ui/toast";
import { useAdminResource } from "@/components/features/admin/use-admin-resource";
import type { AdminActivityLog } from "@/shared/types";

/**
 * The administrator's overview: live totals, and the doors to each admin surface.
 *
 * Read-only. Every figure comes from `/api/admin/*`, each of which checks the
 * caller's role before querying.
 */
export function AdminConsoleClient() {
  const fetchActivity = useCallback(
    () => apiFetch<{ data: AdminActivityLog }>("/api/admin/activity?limit=10").then((r) => r.data),
    [],
  );
  const { data, loading, error, reload } = useAdminResource(fetchActivity);
  const { toasts, dismiss } = useToast();

  const sections = [
    {
      href: "/admin/users",
      icon: Users,
      title: "Users & roles",
      description: "Add a person, change a role, move a reporting line, deactivate a login.",
    },
    {
      href: "/admin/departments",
      icon: Building2,
      title: "Departments",
      description: "The authoritative list employees are filed under.",
    },
    {
      href: "/admin/approval-hierarchy",
      icon: GitBranch,
      title: "Approval hierarchy",
      description: "Set how many approvers a request of each length needs.",
    },
    {
      href: "/admin/activity",
      icon: Activity,
      title: "Activity & audit",
      description: "Live totals and the AI query audit trail.",
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin console"
        description="Everything that shapes how the organisation is run: accounts, departments and the approval rules."
      />

      {loading ? (
        <KpiSkeleton count={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} retrying={loading} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="People" value={data?.totals.employees_total ?? 0} />
            <Stat label="Active" value={data?.totals.employees_active ?? 0} />
            <Stat label="Open approvals" value={data?.totals.approvals_open ?? 0} />
            <Stat label="Pending requests" value={data?.totals.requests_pending ?? 0} />
          </div>

          {data && data.totals.requests_blocked > 0 ? (
            <Card className="border-warning/60 bg-warning/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck className="size-4" aria-hidden />
                  {data.totals.requests_blocked} request
                  {data.totals.requests_blocked === 1 ? "" : "s"} need attention
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  These are parked because no approver could be resolved. Assign a manager or
                  add an approver to the chain so they can move.
                </p>
              </CardContent>
            </Card>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            {sections.map((section) => (
              <Link
                key={section.href}
                href={section.href}
                className="rounded-xl border bg-card p-5 transition-colors hover:bg-accent"
              >
                <div className="flex items-start gap-3">
                  <section.icon className="mt-0.5 size-5 text-muted-foreground" aria-hidden />
                  <div className="min-w-0">
                    <h2 className="font-medium">{section.title}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}