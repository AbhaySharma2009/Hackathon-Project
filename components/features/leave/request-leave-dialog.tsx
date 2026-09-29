"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarPlus, Loader2 } from "lucide-react";
import { apiFetch, ClientApiError } from "@/shared/api-client";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { LEAVE_TYPES, LEAVE_TYPE_LABEL, leaveRequestSchema } from "@/server/leave";
import type { LeaveType, LeaveValidation } from "@/shared/types";
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

function today() {
  return new Date().toISOString().slice(0, 10);
}

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

  const canSubmit = Boolean(datesReady && reason.trim().length >= 5 && check?.valid && !checking);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="size-5" aria-hidden />
            Request leave
          </DialogTitle>
          <DialogDescription>
            Working days exclude Saturdays and Sundays. The request is sent to your
            manager for approval.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="leave-type">Leave type</Label>
            <select
              id="leave-type"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={leaveType}
              onChange={(e) => setLeaveType(e.target.value as LeaveType)}
            >
              {LEAVE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {LEAVE_TYPE_LABEL[type]}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="start-date">From</Label>
              <input
                id="start-date"
                type="date"
                min={today()}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>

          {/* Live server verdict */}
          <div
            className="rounded-md border bg-muted/40 px-3 py-2 text-sm"
            aria-live="polite"
          >
            {!datesReady ? (
              <p className="text-muted-foreground">
                {available} day{available === 1 ? "" : "s"} of{" "}
                {LEAVE_TYPE_LABEL[leaveType].toLowerCase()} leave left this year. Pick a
                date range to see the duration.
              </p>
            ) : checking ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Checking availability…
              </p>
            ) : check?.valid ? (
              <p className="text-emerald-600 dark:text-emerald-400">
                {check.days} working day{check.days === 1 ? "" : "s"} ·{" "}
                {check.available_balance === null
                  ? "no limit for unpaid leave"
                  : `${check.available_balance} day${Number(check.available_balance) === 1 ? "" : "s"} available`}
              </p>
            ) : check ? (
              <div className="space-y-1">
                <p className="font-medium text-destructive">{check.error_message}</p>
                {check.conflicts.length > 0 ? (
                  <ul className="text-xs text-muted-foreground">
                    {check.conflicts.map((c) => (
                      <li key={c.id}>
                        {c.status} leave · {c.start_date} → {c.end_date}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">
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
            <p className="text-xs text-muted-foreground">{reason.trim().length}/500</p>
          </div>

          {submitError ? (
            <p className="text-sm text-destructive" role="alert">
              {submitError.message}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit || submitting}>
            {submitting ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Submit request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
