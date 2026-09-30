"use client";

/**
 * The leave preview card.
 *
 * The assistant produced the draft; the database produced the verdict on it. This
 * component shows the verdict and, only if it passed, offers a submit button.
 *
 * That button posts to `/api/leave-requests` — the same endpoint the manual leave
 * form uses, which re-runs every rule inside `create_leave_request`'s own
 * transaction. Nothing is submitted by the AI: the model has no tool that can
 * write, and this is the employee pressing a button. Whatever the server decides
 * is what gets reported back into the chat, including a refusal.
 */
import { useState } from "react";
import { AlertTriangle, CalendarDays, CheckCircle2, Loader2, Wallet } from "lucide-react";
import { apiFetch, ClientApiError } from "@/shared/api-client";
import { LEAVE_TYPE_LABEL } from "@/server/leave";
import type { LeaveType } from "@/shared/types";
import type { LeavePreviewCard } from "@/server/ai/leave-draft";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

function formatDate(value: string) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export type PreviewOutcome = { tone: "success" | "error"; message: string };

export function LeavePreview({
  card,
  onResult,
}: {
  card: LeavePreviewCard;
  onResult: (outcome: PreviewOutcome) => void;
}) {
  const [reason, setReason] = useState(card.reason);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // The server requires at least 5 characters, and the assistant will not write
  // one in the employee's place — so an empty draft blocks submission here with
  // an explanation rather than a silent default.
  const reasonReady = reason.trim().length >= 5;
  const canSubmit = card.valid && reasonReady && !submitting && !done;

  async function submit() {
    setSubmitting(true);
    try {
      const response = await apiFetch<{ data: { id: string; days: number } }>(
        "/api/leave-requests",
        {
          method: "POST",
          body: JSON.stringify({
            leave_type: card.leave_type,
            start_date: card.start_date,
            end_date: card.end_date,
            reason: reason.trim(),
          }),
        },
      );

      setDone(true);
      onResult({
        tone: "success",
        message: `Your ${LEAVE_TYPE_LABEL[card.leave_type as LeaveType].toLowerCase()} leave request for ${formatDate(card.start_date)} – ${formatDate(card.end_date)} (${response.data.days} working ${response.data.days === 1 ? "day" : "days"}) has been sent to your manager. It is now pending.`,
      });
    } catch (error) {
      // A refusal here is a real answer from the database, not a failure of the
      // assistant, so it is reported in the same voice.
      const code = error instanceof ClientApiError ? error.code : null;
      const message =
        error instanceof ClientApiError
          ? error.message
          : "Could not submit that request. Please try again.";

      onResult({
        tone: "error",
        message: `${message}${code ? ` (${code})` : ""} Nothing was created.`,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      data-slot="leave-preview"
      data-valid={card.valid ? "true" : "false"}
      className="space-y-3.5 rounded-xl border bg-card p-4 text-left shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <CalendarDays className="size-4" aria-hidden />
          Leave preview
        </p>
        {done ? (
          <Badge variant="success">
            <CheckCircle2 aria-hidden />
            Submitted
          </Badge>
        ) : card.valid ? (
          <Badge variant="success">
            <CheckCircle2 aria-hidden />
            Ready to send
          </Badge>
        ) : (
          <Badge variant="destructive">
            <AlertTriangle aria-hidden />
            Cannot be sent
          </Badge>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Leave type</dt>
          <dd className="mt-0.5 font-medium">
            {LEAVE_TYPE_LABEL[card.leave_type as LeaveType] ?? card.leave_type}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Duration</dt>
          <dd className="tabular mt-0.5 font-medium">
            {card.days} working {card.days === 1 ? "day" : "days"}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs text-muted-foreground">Dates</dt>
          <dd className="mt-0.5 font-medium">
            {formatDate(card.start_date)} – {formatDate(card.end_date)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Available balance</dt>
          <dd className="tabular mt-0.5 flex items-center gap-1 font-medium">
            <Wallet className="size-3.5" aria-hidden />
            {card.available_balance ?? "—"}
          </dd>
        </div>
      </dl>

      {card.valid ? (
        <p className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/8 px-3 py-2 text-sm text-success-foreground">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
          No overlapping leave detected, and the balance covers it.
        </p>
      ) : (
        <div className="space-y-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm">
          <p className="flex items-start gap-2 font-medium text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {card.error?.message ?? "This request cannot be sent."}
          </p>
          {card.conflicts?.map((conflict) => (
            <p key={conflict.id} className="tabular pl-6 text-muted-foreground">
              Overlaps your {conflict.status} leave from {formatDate(conflict.start_date)} –{" "}
              {formatDate(conflict.end_date)}.
            </p>
          ))}
        </div>
      )}

      {!done ? (
        <div className="space-y-1.5">
          <Label htmlFor="copilot-reason" className="text-sm font-medium">
            Reason
          </Label>
          <Textarea
            id="copilot-reason"
            rows={2}
            value={reason}
            disabled={!card.valid}
            onChange={(event) => setReason(event.target.value)}
            placeholder="A short note for your manager."
          />
          {!reasonReady ? (
            <p className="text-xs text-muted-foreground">
              Add a reason of at least 5 characters to send this.
            </p>
          ) : null}
        </div>
      ) : null}

      {!done ? (
        <Button size="lg" className="w-full" onClick={submit} disabled={!canSubmit} aria-busy={submitting}>
          {submitting ? <Loader2 className="animate-spin" aria-hidden /> : <CheckCircle2 aria-hidden />}
          {submitting ? "Sending…" : "Submit leave request"}
        </Button>
      ) : null}
    </div>
  );
}
