"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LEAVE_TYPE_LABEL } from "@/server/leave";
import type { LeaveRequest, LeaveStatus } from "@/shared/types";

const STATUS_VARIANT: Record<LeaveStatus, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  approved: "default",
  rejected: "destructive",
  cancelled: "outline",
};

function formatRange(start: string, end: string) {
  const format = (value: string) =>
    new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  return start === end ? format(start) : `${format(start)} → ${format(end)}`;
}

export function LeaveHistory({
  requests,
  onSelect,
}: {
  requests: LeaveRequest[];
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Request history</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead className="text-right">Days</TableHead>
                <TableHead>Status</TableHead>
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
                    <Badge variant={STATUS_VARIANT[request.status]}>{request.status}</Badge>
                  </TableCell>
                  <TableCell className="max-w-56 truncate text-xs text-muted-foreground">
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
