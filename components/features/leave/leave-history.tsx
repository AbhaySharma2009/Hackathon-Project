"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LEAVE_TYPE_LABEL } from "@/server/leave";
import { Button } from "@/components/ui/button";
import { ApprovalStageLine } from "@/components/features/approvals/approval-timeline";
import { StatusBadge } from "@/components/design/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { MyLeaveRequest } from "@/shared/types";

function formatRange(start: string, end: string) {
  const format = (value: string) =>
    new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  return start === end ? format(start) : `${format(start)} → ${format(end)}`;
}

/**
 * Whether the cancel affordance is offered.
 *
 * This is only a hint so the button is not shown where it cannot work. The
 * database re-checks ownership, pending status and start date inside
 * `cancel_leave_request`, so a stale or hand-crafted value here grants nothing.
 */
function canCancel(request: MyLeaveRequest): boolean {
  if (request.status !== "pending") return false;
  const start = new Date(`${request.start_date}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return start > today;
}

export function LeaveHistory({
  requests,
  onSelect,
  onCancel,
  cancellingId,
}: {
  requests: MyLeaveRequest[];
  onSelect: (id: string) => void;
  /** Omitted where cancellation is not wired up. */
  onCancel?: (id: string) => void;
  cancellingId?: string | null;
}) {
  const [target, setTarget] = useState<MyLeaveRequest | null>(null);

  const confirm = () => {
    if (!target) return;
    onCancel?.(target.id);
    setTarget(null);
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Request history</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead className="text-right">Days</TableHead>
                <TableHead>Status</TableHead>
                {/* Phase 3.5: where the request has got to, in the form the phase
                    asks for — `Manager ✓ → Department Head ● → HR ○`. */}
                <TableHead>Approval progress</TableHead>
                <TableHead>Note</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((request) => (
                <TableRow
                  key={request.id}
                  className="cursor-pointer"
                  onClick={() => onSelect(request.id)}
                >
                  <TableCell className="font-medium">
                    {LEAVE_TYPE_LABEL[request.leave_type]}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatRange(request.start_date, request.end_date)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{request.days}</TableCell>
                  <TableCell>
                    <StatusBadge status={request.status} />
                    {request.status === "approval_blocked" && request.blocked_reason ? (
                      <p className="mt-1 max-w-48 text-xs text-muted-foreground">
                        {request.blocked_reason}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {request.approval_chain.length > 0 ? (
                      <ApprovalStageLine steps={request.approval_chain} />
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-56 truncate text-sm text-muted-foreground">
                    {request.manager_comment ?? "—"}
                  </TableCell>
                  <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
                    {onCancel && canCancel(request) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        disabled={cancellingId === request.id}
                        onClick={() => setTarget(request)}
                      >
                        {cancellingId === request.id ? "Cancelling…" : "Cancel"}
                      </Button>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Cancelling is immediate and withdraws the approval chain, so it is
          confirmed rather than done on the first click. */}
      <AlertDialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this leave request?</AlertDialogTitle>
            <AlertDialogDescription>
              {target
                ? `${LEAVE_TYPE_LABEL[target.leave_type]} from ${formatRange(target.start_date, target.end_date)} will be withdrawn and your approvers will be notified. No leave balance changes, because nothing has been deducted yet.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep request</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={confirm}
            >
              Cancel request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
