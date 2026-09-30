"use client";

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Separator } from "@/components/ui/separator";
import { LEAVE_TYPE_LABEL } from "@/server/leave";
import { STEP_ROLE_LABEL } from "@/components/features/approvals/approval-timeline";
import type { MyLeaveRequest } from "@/shared/types";
import { StatusBadge } from "@/components/design/status-badge";
import type { LeaveStatus } from "@/shared/types";

const STATUS_NOTE: Record<LeaveStatus, string> = {
  pending: "Waiting for your manager to review this request.",
  approved: "Approved. These days have been deducted from your balance.",
  rejected: "This request was not approved.",
  cancelled: "This request was cancelled.",
  approval_blocked: "This request could not be routed for approval. HR can decide it.",
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
  request: MyLeaveRequest | null;
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
              <StatusBadge status={request.status} />
              <span className="text-sm text-muted-foreground">{STATUS_NOTE[request.status]}</span>
            </div>

            <dl className="grid grid-cols-3 gap-x-3 gap-y-2.5 text-sm">
              <dt className="text-muted-foreground">From</dt>
              <dd className="col-span-2">{formatDate(request.start_date)}</dd>

              <dt className="text-muted-foreground">To</dt>
              <dd className="col-span-2">{formatDate(request.end_date)}</dd>

              <dt className="text-muted-foreground">Working days</dt>
              <dd className="tabular col-span-2 font-medium">{request.days}</dd>

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

            {/* The complete approval history: every level that was required, who
                held it, what they said, and when. A step that was not required is
                shown as such rather than hidden, so the record explains itself. */}
            {request.approval_chain.length > 0 ? (
              <>
                <Separator />
                <div className="space-y-3">
                  <p className="text-sm font-medium">Approval history</p>
                  <ol className="space-y-3">
                    {request.approval_chain.map((step) => (
                      <li key={step.id} className="flex gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm">
                            <span className="font-medium">
                              {STEP_ROLE_LABEL[step.approver_role]}
                            </span>
                            <span className="text-muted-foreground"> — {step.approver_name}</span>
                          </p>
                          {step.decided_at ? (
                            <p className="text-xs text-muted-foreground">
                              {step.status === "approved" ? "Approved" : "Rejected"} on{" "}
                              {formatDate(step.decided_at)}
                            </p>
                          ) : step.status === "skipped" ? (
                            <p className="text-xs text-muted-foreground">
                              Not required for this request.
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              {step.is_current ? "Waiting for this approver" : "Not reached yet"}
                            </p>
                          )}
                          {step.comment ? (
                            <p className="mt-1 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                              “{step.comment}”
                            </p>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ol>
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
