"use client";

import { Badge } from "@/components/ui/badge";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Separator } from "@/components/ui/separator";
import { LEAVE_TYPE_LABEL } from "@/lib/leave";
import type { LeaveRequest, LeaveStatus } from "@/lib/types";

const STATUS_VARIANT: Record<LeaveStatus, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  approved: "default",
  rejected: "destructive",
  cancelled: "outline",
};

const STATUS_NOTE: Record<LeaveStatus, string> = {
  pending: "Waiting for your manager to review this request.",
  approved: "Approved. These days have been deducted from your balance.",
  rejected: "This request was not approved.",
  cancelled: "This request was cancelled.",
};

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function LeaveRequestDrawer({
  request,
  onOpenChange,
}: {
  request: LeaveRequest | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Drawer open={request !== null} onOpenChange={onOpenChange}>
      <DrawerContent className="w-full max-w-md">
        <DrawerHeader>
          <DrawerTitle>
            {request ? `${LEAVE_TYPE_LABEL[request.leave_type]} leave` : "Leave request"}
          </DrawerTitle>
          <DrawerDescription>
            {request ? `${request.days} working day${Number(request.days) === 1 ? "" : "s"}` : ""}
          </DrawerDescription>
        </DrawerHeader>

        {request ? (
          <div className="space-y-5 px-4 pb-6">
            <div className="flex items-center gap-2">
              <Badge variant={STATUS_VARIANT[request.status]}>{request.status}</Badge>
              <span className="text-xs text-muted-foreground">{STATUS_NOTE[request.status]}</span>
            </div>

            <dl className="grid grid-cols-3 gap-3 text-sm">
              <dt className="text-muted-foreground">From</dt>
              <dd className="col-span-2">{formatDate(request.start_date)}</dd>

              <dt className="text-muted-foreground">To</dt>
              <dd className="col-span-2">{formatDate(request.end_date)}</dd>

              <dt className="text-muted-foreground">Working days</dt>
              <dd className="col-span-2 tabular-nums">{request.days}</dd>

              <dt className="text-muted-foreground">Requested on</dt>
              <dd className="col-span-2">{formatDate(request.created_at)}</dd>

              {request.decided_at ? (
                <>
                  <dt className="text-muted-foreground">Decided on</dt>
                  <dd className="col-span-2">{formatDate(request.decided_at)}</dd>
                </>
              ) : null}
            </dl>

            {request.reason ? (
              <>
                <Separator />
                <div>
                  <p className="text-sm font-medium">Reason</p>
                  <p className="mt-1 text-sm text-muted-foreground">{request.reason}</p>
                </div>
              </>
            ) : null}

            {request.manager_comment ? (
              <>
                <Separator />
                <div>
                  <p className="text-sm font-medium">
                    {request.status === "rejected" ? "Why it was rejected" : "Manager comment"}
                  </p>
                  <p className="mt-1 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                    {request.manager_comment}
                  </p>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}
