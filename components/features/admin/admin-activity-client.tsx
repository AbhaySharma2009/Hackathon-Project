"use client";

import { useCallback } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/design/page-header";
import { EmptyState, ErrorState } from "@/components/design/states";
import { KpiSkeleton } from "@/components/design/loaders";
import { useAdminResource } from "@/components/features/admin/use-admin-resource";
import type { AdminActivityLog } from "@/shared/types";

/**
 * Live workflow totals, and every AI query the system has answered.
 *
 * The audit trail is the reason this page is admin-only: it shows what was asked,
 * whether it succeeded, how long it took and how many rows came back, which is
 * what makes the "the assistant can read but not change anything" claim
 * checkable rather than merely stated.
 */
export function AdminActivityClient() {
  const fetchActivity = useCallback(
    () =>
      apiFetch<{ data: AdminActivityLog }>("/api/admin/activity?limit=50").then((r) => r.data),
    [],
  );
  const { data: log, loading, error, reload } = useAdminResource(fetchActivity);

  const t = log?.totals;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity & audit"
        description="Live workflow totals and the AI query audit trail."
      />

      {loading ? (
        <KpiSkeleton count={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} retrying={loading} />
      ) : (
        <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="People" value={t?.employees_total ?? 0} />
        <Stat label="Pending requests" value={t?.requests_pending ?? 0} />
        <Stat label="Open approvals" value={t?.approvals_open ?? 0} />
        <Stat label="Unread alerts" value={t?.open_alerts ?? 0} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>AI query audit</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {(log?.ai_audit ?? []).length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="No queries yet"
              description="Anything asked of the assistant is recorded here."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Tool</TableHead>
                  <TableHead>Arguments</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="text-right">Took</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(log?.ai_audit ?? []).map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {new Date(entry.created_at).toLocaleString("en-IN", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </TableCell>
                    <TableCell className="font-medium">{entry.tool_name}</TableCell>
                    <TableCell className="max-w-48 truncate font-mono text-xs text-muted-foreground">
                      {entry.arguments ? JSON.stringify(entry.arguments) : "—"}
                    </TableCell>
                    <TableCell>
                      {entry.success ? (
                        <span className="inline-flex items-center gap-1.5 text-sm text-success">
                          <CheckCircle2 className="size-4" aria-hidden />
                          Answered
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1.5 text-sm text-destructive"
                          title={entry.error ?? undefined}
                        >
                          <XCircle className="size-4" aria-hidden />
                          {entry.error ? "Failed" : "Unavailable"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                      {entry.duration_ms !== null ? `${entry.duration_ms} ms` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
        </>
      )}
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
