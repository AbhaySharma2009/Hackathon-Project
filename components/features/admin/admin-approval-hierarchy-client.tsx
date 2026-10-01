"use client";

import { useCallback, useState } from "react";
import { Check, CircleSlash } from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/design/page-header";
import { ErrorState } from "@/components/design/states";
import { CardSkeleton } from "@/components/design/loaders";
import { ToastViewport, useToast } from "@/components/ui/toast";
import { useAdminResource } from "@/components/features/admin/use-admin-resource";
import type { ApprovalPolicy, RequiredApprovalLevels } from "@/shared/types";

type Sample = { days: number; levels: RequiredApprovalLevels };

/**
 * The approval thresholds, and what they currently imply.
 *
 * The "implied chain" column is not computed here: each row comes from calling
 * `required_approval_levels` in the database, the same function
 * `create_leave_request` uses when it builds a chain. So the preview cannot drift
 * away from the rule that will actually be applied.
 */
export function AdminApprovalHierarchyClient() {
  const [draft, setDraft] = useState({ short: 0, medium: 0, hrOverSeven: true });
  const [busy, setBusy] = useState(false);
  const { toasts, toast, dismiss } = useToast();

  const fetchPolicy = useCallback(
    () =>
      apiFetch<{ data: { policy: ApprovalPolicy; samples: Sample[] } }>(
        "/api/admin/approval-policy",
      ).then((r) => r.data),
    [],
  );
  const { data, loading, error, reload } = useAdminResource(fetchPolicy);

  const policy = data?.policy ?? null;
  const samples = data?.samples ?? [];

  const save = async () => {
    setBusy(true);
    try {
      await apiFetch("/api/admin/approval-policy", {
        method: "PATCH",
        body: JSON.stringify({
          short_leave_max_days: draft.short,
          medium_leave_max_days: draft.medium,
          require_hr_over_seven: draft.hrOverSeven,
        }),
      });
      await reload();
      toast({
        tone: "success",
        title: "Thresholds updated",
        description: "Requests already in flight keep the routing they were built with.",
      });
    } catch (err) {
      toast({
        tone: "error",
        title: "Could not save",
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
    } finally {
      setBusy(false);
    }
  };

  const dirty =
    policy &&
    (draft.short !== policy.short_leave_max_days ||
      draft.medium !== policy.medium_leave_max_days ||
      draft.hrOverSeven !== policy.require_hr_over_seven);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approval hierarchy"
        description="How many approvers a request of a given length needs."
      />

      {loading ? (
        <CardSkeleton />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} retrying={loading} />
      ) : (
        <>
      <Card>
        <CardHeader>
          <CardTitle>Thresholds</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="short">Up to this many days needs one approver</Label>
              <Input
                id="short"
                type="number"
                min={0}
                value={draft.short}
                onChange={(e) => setDraft((d) => ({ ...d, short: Number(e.target.value) }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="medium">
                Beyond the short limit, up to this many days needs two
              </Label>
              <Input
                id="medium"
                type="number"
                min={1}
                value={draft.medium}
                onChange={(e) => setDraft((d) => ({ ...d, medium: Number(e.target.value) }))}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.hrOverSeven}
              onChange={(e) => setDraft((d) => ({ ...d, hrOverSeven: e.target.checked }))}
            />
            Anything longer than {draft.medium} days also needs HR
          </label>

          {draft.short >= draft.medium ? (
            <p className="text-sm text-destructive">
              The short-leave limit must be below the medium-leave limit.
            </p>
          ) : null}

          <Button onClick={save} disabled={busy || !dirty || draft.short >= draft.medium}>
            {busy ? "Saving…" : "Save thresholds"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What each length needs</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Working days</TableHead>
                <TableHead>Manager</TableHead>
                <TableHead>Department head</TableHead>
                <TableHead>HR</TableHead>
                <TableHead className="text-right">Approvers</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {samples.map((sample) => (
                <TableRow key={sample.days}>
                  <TableCell className="font-medium tabular-nums">{sample.days}</TableCell>
                  <Flag on={sample.levels.needs_manager} />
                  <Flag on={sample.levels.needs_department_head} />
                  <Flag on={sample.levels.needs_hr} />
                  <TableCell className="text-right tabular-nums">
                    {sample.levels.level_count}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
        </>
      )}

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function Flag({ on }: { on: boolean }) {
  return on ? (
    <TableCell>
      <Check className="size-4 text-success" aria-label="required" />
    </TableCell>
  ) : (
    <TableCell>
      <CircleSlash className="size-4 text-muted-foreground/40" aria-label="not required" />
    </TableCell>
  );
}
