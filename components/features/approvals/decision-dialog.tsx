"use client";

import { useState } from "react";
import { Loader2, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import { apiFetch, ClientApiError } from "@/shared/api-client";
import { LEAVE_TYPE_LABEL } from "@/server/leave";
import type { ApprovalRequest, LeaveRequest } from "@/shared/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Decision = "approve" | "reject";

function formatRange(start: string, end: string) {
  const format = (value: string) =>
    new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  return start === end ? format(start) : `${format(start)} → ${format(end)}`;
}

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

/**
 * Approve / Reject modal.
 *
 * The button the user clicked decides the call, so the confirm button never
 * changes identity mid-decision and a stray second click cannot reject a request
 * the user meant to approve.
 */
export function DecisionDialog({
  request,
  decision,
  onOpenChange,
  onDecided,
}: {
  request: ApprovalRequest | null;
  decision: Decision;
  onOpenChange: (open: boolean) => void;
  onDecided: (message: string, tone: "success" | "error") => void;
}) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isApprove = decision === "approve";
  const trimmed = comment.trim();
  const canSubmit = isApprove ? true : trimmed.length >= 3;

  function reset() {
    setComment("");
    setError(null);
    setSubmitting(false);
  }

  async function submit() {
    if (!request) return;
    setSubmitting(true);
    setError(null);

    try {
      const updated = await apiFetch<{ data: LeaveRequest }>(
        `/api/leave-requests/${request.id}/${decision}`,
        { method: "POST", body: JSON.stringify({ comment: trimmed || undefined }) },
      );

      onOpenChange(false);
      onDecided(
        isApprove
          ? `Approved ${request.employee_name}'s ${LEAVE_TYPE_LABEL[request.leave_type].toLowerCase()} leave for ${request.days} day${
              Number(request.days) === 1 ? "" : "s"
            }. Their balance is updated.`
          : `Rejected ${request.employee_name}'s request and sent your reason.`,
        "success",
      );
      // `updated` is intentionally unused beyond proving the call succeeded; the
      // list refetch below is the source of truth for the new state.
      void updated;
    } catch (err) {
      const message =
        err instanceof ClientApiError ? err.message : "Could not record that decision.";
      setError(message);
      onDecided(message, "error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={Boolean(request)}
      onOpenChange={(open) => {
        if (!open) reset();
        onOpenChange(open);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isApprove ? (
              <ThumbsUp className="size-5" aria-hidden />
            ) : (
              <ThumbsDown className="size-5" aria-hidden />
            )}
            {isApprove ? "Approve leave request" : "Reject leave request"}
          </DialogTitle>
          <DialogDescription>
            {isApprove
              ? "Approving spends the days from this employee's balance. The change happens in one database transaction."
              : "The employee sees your reason. Rejecting does not change any balance."}
          </DialogDescription>
        </DialogHeader>

        {request ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-md border bg-muted/40 p-3">
              <Avatar>
                {request.employee_photo ? (
                  <AvatarImage src={request.employee_photo} alt="" />
                ) : (
                  <AvatarFallback>{initials(request.employee_name)}</AvatarFallback>
                )}
              </Avatar>
              <div className="min-w-0">
                <p className="truncate font-medium">{request.employee_name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {request.employee_role} · {request.employee_department}
                </p>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Type</dt>
                <dd>
                  <Badge variant="outline">{LEAVE_TYPE_LABEL[request.leave_type]}</Badge>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Duration</dt>
                <dd className="tabular-nums">{request.days} working days</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-muted-foreground">Dates</dt>
                <dd>{formatRange(request.start_date, request.end_date)}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-muted-foreground">Reason given</dt>
                <dd className="text-muted-foreground">{request.reason}</dd>
              </div>
            </dl>

            {/* Phase 6 fills this in with the knock-on effects of the decision
                (who else is out, coverage risk, trend context). */}
            <div
              data-slot="leave-impact"
              className="flex items-start gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground"
            >
              <Sparkles className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div>
                <p className="font-medium text-foreground">Leave Impact</p>
                <p className="text-xs">
                  Team coverage and workload insights will appear here in a later phase.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="decision-comment">
                {isApprove ? "Comment (optional)" : "Reason for rejection"}
              </Label>
              <Textarea
                id="decision-comment"
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={
                  isApprove
                    ? "Anything the employee should know before they go."
                    : "Tell the employee what to change so they can re-apply."
                }
              />
              {!isApprove && trimmed.length > 0 && trimmed.length < 3 ? (
                <p className="text-xs text-destructive">
                  Give at least 3 characters so the employee knows what to change.
                </p>
              ) : null}
            </div>

            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant={isApprove ? "default" : "destructive"}
            onClick={submit}
            disabled={!canSubmit || submitting}
          >
            {submitting ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {isApprove ? "Approve request" : "Reject request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
