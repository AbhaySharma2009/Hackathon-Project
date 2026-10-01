"use client";

/**
 * The Super Admin console.
 *
 * Read-only overview plus the doors to the two Super-Admin-only surfaces. Every
 * figure comes from `/api/admin/*`, which accepts an Admin as well as a Super
 * Admin — the Super Admin is not shown anything an Admin cannot already see,
 * they simply have the extra controls alongside.
 */
import { useCallback } from "react";
import Link from "next/link";
import { Activity, Building2, GitBranch, ShieldAlert, Users } from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/design/page-header";
import { ErrorState } from "@/components/design/states";
import { KpiSkeleton } from "@/components/design/loaders";
import { ToastViewport, useToast } from "@/components/ui/toast";
import { useAdminResource } from "@/components/features/admin/use-admin-resource";
import type { AdminActivityLog } from "@/shared/types";

export function SuperAdminConsoleClient() {
  const fetchActivity = useCallback(
    () => apiFetch<{ data: AdminActivityLog }>("/api/admin/activity?limit=10").then((r) => r.data),
    [],
  );
  const { data, loading, error, reload } = useAdminResource(fetchActivity);
  const { toasts, dismiss } = useToast();

  const sections = [
    {
      href: "/super-admin/access",
      icon: ShieldAlert,
      title: "Access & escalation",
      description:
        "Which roles may be assigned, and who signs a Super Admin's own leave. Nobody can appoint themselves.",
    },
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
        title="Super Admin console"
        description="Complete system access: every role tier, every account, and the escalation rules above all of them."
        actions={<Badge>Super Admin</Badge>}
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
                  <ShieldAlert className="size-4" aria-hidden />
                  {data.totals.requests_blocked} request
                  {data.totals.requests_blocked === 1 ? "" : "s"} need attention
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Parked because no approver could be resolved. A Super Admin or Super Admin leave
                  request with nobody configured above it lands here rather than being self-approved.
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