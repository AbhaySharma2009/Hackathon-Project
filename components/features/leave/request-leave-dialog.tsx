"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CalendarPlus,
  Check,
  CircleAlert,
  Loader2,
  Send,
  type LucideIcon,
} from "lucide-react";
import { apiFetch, ClientApiError } from "@/shared/api-client";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { LEAVE_TYPES, LEAVE_TYPE_LABEL, leaveRequestSchema } from "@/server/leave";
import type { LeaveType, LeaveValidation } from "@/shared/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/shared/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type BalanceRow = {
  id: string;
  leave_type: LeaveType;
  year: number;
  allocated: number;
  used: number;
  remaining: number;
};

const ERROR_HINT: Record<string, string> = {
  OVERLAP: "Pick dates that do not clash with an existing request.",
  INSUFFICIENT_BALANCE: "Try fewer days, a different leave type, or ask HR.",
  INVALID_DATES: "Adjust the dates and try again.",
};

const TYPE_ICON: Record<LeaveType, LucideIcon> = {
  casual: CalendarPlus,
  sick: CircleAlert,
  annual: Check,
  unpaid: Send,
};

const STEPS = [
  { key: "type", label: "Select leave" },
  { key: "dates", label: "Select dates" },
  { key: "review", label: "Review" },
] as const;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function prettyDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * The leave request flow, as three steps: type, dates, review.
 *
 * The steps only reorganise the form. Validation is unchanged — it is still the
 * debounced `POST /api/leave-requests/validate` dry run against the same RPC, and
 * the submit is still the same POST. Nothing is decided on the client, and the
 * submit button stays disabled until the server has said the request is valid.
 */
export function RequestLeaveDialog({
  open,
  onOpenChange,
  balances,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  balances: BalanceRow[];
  onCreated: () => void;
}) {
  const [step, setStep] = useState(0);
  const [leaveType, setLeaveType] = useState<LeaveType>("casual");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");

  const [submitError, setSubmitError] = useState<ClientApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const available = useMemo(
    () => balances.find((b) => b.leave_type === leaveType)?.remaining ?? 0,
    [balances, leaveType],
  );

  const datesReady = Boolean(startDate && endDate);
  const debouncedStart = useDebouncedValue(startDate, 400);
  const debouncedEnd = useDebouncedValue(endDate, 400);
  const debouncedType = useDebouncedValue(leaveType, 200);

  // The dry run only depends on the type and the dates, never on the reason, so
  // typing does not fire a request per keystroke.
  const query = useMemo(() => {
    if (!debouncedStart || !debouncedEnd) return null;
    const parsed = leaveRequestSchema.safeParse({
      leave_type: debouncedType,
      start_date: debouncedStart,
      end_date: debouncedEnd,
      reason: "dry run",
    });
    return parsed.success ? parsed.data : null;
  }, [debouncedStart, debouncedEnd, debouncedType]);

  // A result is only shown while it belongs to the current query, which keeps
  // the panel from flashing a stale verdict while a new one is in flight.
  const [result, setResult] = useState<{ key: string; data: LeaveValidation } | null>(null);
  const queryKey = query ? `${query.leave_type}|${query.start_date}|${query.end_date}` : null;
  const check = result && result.key === queryKey ? result.data : null;
  const checking = queryKey !== null && result?.key !== queryKey;

  useEffect(() => {
    if (!query || !queryKey) return;
    const controller = new AbortController();

    apiFetch<{ data: LeaveValidation }>("/api/leave-requests/validate", {
      method: "POST",
      body: JSON.stringify(query),
      signal: controller.signal,
    })
      .then((res) => setResult({ key: queryKey, data: res.data }))
      .catch((err: Error) => {
        if (err.name !== "AbortError") setSubmitError(err as ClientApiError);
      });

    return () => controller.abort();
  }, [query, queryKey]);

  function reset() {
    setStep(0);
    setLeaveType("casual");
    setStartDate("");
    setEndDate("");
    setReason("");
    setResult(null);
    setSubmitError(null);
  }

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await apiFetch("/api/leave-requests", {
        method: "POST",
        body: JSON.stringify({ leave_type: leaveType, start_date: startDate, end_date: endDate, reason }),
      });
      reset();
      onCreated();
      onOpenChange(false);
    } catch (err) {
      setSubmitError(err instanceof ClientApiError ? err : null);
    } finally {
      setSubmitting(false);
    }
  }

  const datesValid = datesReady && check?.valid === true && !checking;
  const reasonReady = reason.trim().length >= 5;
  const canSubmit = Boolean(datesValid && reasonReady && !checking);
  const canLeaveTypeStep = true;
  const canLeaveDatesStep = datesValid && reasonReady;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-section-title font-semibold">
            <CalendarPlus className="size-5 text-primary" aria-hidden />
            Request leave
          </DialogTitle>
          <DialogDescription>
            Working days exclude Saturdays and Sundays. The request is routed to your approvers
            automatically.
          </DialogDescription>
        </DialogHeader>

        {/* Progress rail. The current step is named, not just coloured. */}
        <ol className="flex items-center gap-1.5" aria-label="Request progress">
          {STEPS.map((entry, index) => {
            const state = index < step ? "done" : index === step ? "current" : "upcoming";
            return (
              <li key={entry.key} className="flex flex-1 items-center gap-1.5">
                <span
                  aria-hidden
                  className={cn(
                    "grid size-6 shrink-0 place-items-center rounded-full border text-2xs font-semibold transition-colors",
                    state === "done" && "border-success bg-success text-white",
                    state === "current" && "border-primary bg-primary text-primary-foreground",
                    state === "upcoming" && "border-border text-muted-foreground",
                  )}
                >
                  {state === "done" ? <Check className="size-3.5" /> : index + 1}
                </span>
                <span
                  className={cn(
                    "hidden truncate text-sm sm:block",
                    state === "current" ? "font-semibold" : "text-muted-foreground",
                  )}
                >
                  {entry.label}
                </span>
                {index < STEPS.length - 1 ? (
                  <span
                    aria-hidden
                    className={cn(
                      "h-px min-w-3 flex-1",
                      state === "done" ? "bg-success/50" : "bg-border",
                    )}
                  />
                ) : null}
              </li>
            );
          })}
        </ol>

        <div className="min-h-64">
          {step === 0 ? (
            <div className="space-y-3">
              <fieldset className="space-y-2.5">
                <legend className="text-sm font-medium">Which kind of leave do you need?</legend>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {LEAVE_TYPES.map((type) => {
                    const Icon = TYPE_ICON[type];
                    const balance = balances.find((b) => b.leave_type === type);
                    const remaining = balance?.remaining ?? 0;
                    const uncapped = type === "unpaid";
                    const selected = leaveType === type;
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => setLeaveType(type)}
                        aria-pressed={selected}
                        className={cn(
                          "flex items-center gap-3 rounded-xl border p-3.5 text-left transition-[border-color,box-shadow,background-color] duration-150",
                          selected
                            ? "border-primary bg-primary/5 shadow-sm"
                            : "hover:border-primary/30 hover:bg-accent/50",
                        )}
                      >
                        <span
                          className={cn(
                            "grid size-9 shrink-0 place-items-center rounded-lg",
                            selected ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                          )}
                        >
                          <Icon className="size-4" aria-hidden />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold">
                            {LEAVE_TYPE_LABEL[type]}
                          </span>
                          <span className="block text-sm text-muted-foreground">
                            {uncapped
                              ? "No limit"
                              : `${remaining} day${remaining === 1 ? "" : "s"} left`}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="start-date">From</Label>
                  <input
                    id="start-date"
                    type="date"
                    min={today()}
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="h-9 w-full rounded-lg border border-input bg-background px-3 text-body outline-none transition-[color,box-shadow,border-color] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="end-date">To</Label>
                  <input
                    id="end-date"
                    type="date"
                    min={startDate || today()}
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="h-9 w-full rounded-lg border border-input bg-background px-3 text-body outline-none transition-[color,box-shadow,border-color] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25"
                  />
                </div>
              </div>

              {/* Live server verdict. The only thing that can enable the next
                  step is the database's own answer. */}
              <div
                className={cn(
                  "rounded-lg border px-3.5 py-3 text-sm",
                  checking && "bg-muted/40",
                  check?.valid && "border-success/40 bg-success/8",
                  check && !check.valid && "border-destructive/40 bg-destructive/5",
                  !datesReady && "bg-muted/40",
                )}
                aria-live="polite"
              >
                {!datesReady ? (
                  <p className="text-muted-foreground">
                    {available} day{available === 1 ? "" : "s"} of{" "}
                    {LEAVE_TYPE_LABEL[leaveType].toLowerCase()} leave left this year. Pick a date
                    range to see the duration.
                  </p>
                ) : checking ? (
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    Checking availability…
                  </p>
                ) : check?.valid ? (
                  <p className="flex items-center gap-2 font-medium text-success-foreground">
                    <Check className="size-4" aria-hidden />
                    {check.days} working day{check.days === 1 ? "" : "s"} ·{" "}
                    {check.available_balance === null
                      ? "no limit for unpaid leave"
                      : `${check.available_balance} day${Number(check.available_balance) === 1 ? "" : "s"} available`}
                  </p>
                ) : check ? (
                  <div className="space-y-1.5">
                    <p className="flex items-center gap-2 font-medium text-destructive">
                      <CircleAlert className="size-4 shrink-0" aria-hidden />
                      {check.error_message}
                    </p>
                    {check.conflicts.length > 0 ? (
                      <ul className="space-y-0.5 pl-6 text-sm text-muted-foreground">
                        {check.conflicts.map((conflict) => (
                          <li key={conflict.id} className="list-disc">
                            {conflict.status} leave · {conflict.start_date} → {conflict.end_date}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="pl-6 text-sm text-muted-foreground">
                        {ERROR_HINT[check.error_code ?? ""] ?? ""}
                      </p>
                    )}
                  </div>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor="reason">Reason</Label>
                <Textarea
                  id="reason"
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why do you need this time off? (5–500 characters)"
                />
                <p className="text-sm text-muted-foreground">{reason.trim().length}/500</p>
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-4">
              <dl className="divide-y overflow-hidden rounded-xl border">
                {[
                  { term: "Leave type", detail: LEAVE_TYPE_LABEL[leaveType] },
                  { term: "From", detail: prettyDate(startDate) },
                  { term: "To", detail: prettyDate(endDate) },
                  {
                    term: "Working days",
                    detail: `${check?.days ?? 0} day${check?.days === 1 ? "" : "s"}`,
                  },
                  {
                    term: "Balance after this",
                    detail:
                      check?.available_balance === null || check?.available_balance === undefined
                        ? "No limit (unpaid)"
                        : `${Math.max(Number(check.available_balance) - Number(check.days ?? 0), 0)} of ${
                            balances.find((b) => b.leave_type === leaveType)?.allocated ?? 0
                          } left`,
                  },
                ].map((row) => (
                  <div key={row.term} className="flex items-baseline gap-4 px-4 py-2.5">
                    <dt className="w-40 shrink-0 text-sm text-muted-foreground">{row.term}</dt>
                    <dd className="text-sm font-medium">{row.detail}</dd>
                  </div>
                ))}
              </dl>

              <div className="space-y-1.5">
                <p className="text-sm font-medium">Your reason</p>
                <p className="rounded-lg border bg-muted/40 px-3.5 py-2.5 text-sm leading-relaxed">
                  {reason}
                </p>
              </div>

              {/* What happens next. Descriptive only — the chain itself is built
                  and frozen by the database when the request is created. */}
              <div className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3">
                <p className="text-sm font-semibold">What happens next</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Up to 3 working days your manager decides. 4–7 days adds your department head,
                  and more than 7 days also goes to HR. The exact chain is fixed when you submit.
                </p>
              </div>

              {submitError ? (
                <p
                  role="alert"
                  className="rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive"
                >
                  {submitError.message}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {step > 0 ? (
            <Button variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={submitting}>
              <ArrowLeft aria-hidden />
              Back
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
          )}

          {step < STEPS.length - 1 ? (
            <Button
              onClick={() => setStep((s) => s + 1)}
              disabled={step === 0 ? !canLeaveTypeStep : !canLeaveDatesStep}
            >
              Continue
            </Button>
          ) : (
            <Button onClick={submit} disabled={!canSubmit || submitting} aria-busy={submitting}>
              {submitting ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Send aria-hidden />
              )}
              {submitting ? "Submitting…" : "Submit request"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
