"use client";

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
import { ApprovalStageLine } from "@/components/features/approvals/approval-timeline";
import { StatusBadge } from "@/components/design/status-badge";
import type { MyLeaveRequest } from "@/shared/types";

function formatRange(start: string, end: string) {
  const format = (value: string) =>
    new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  return start === end ? format(start) : `${format(start)} → ${format(end)}`;
}

export function LeaveHistory({
  requests,
  onSelect,
}: {
  requests: MyLeaveRequest[];
  onSelect: (id: string) => void;
}) {
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
