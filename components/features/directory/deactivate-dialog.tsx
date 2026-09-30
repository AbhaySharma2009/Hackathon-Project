"use client";

import { useState } from "react";
import { ChevronDown, Loader2, UserMinus } from "lucide-react";
import { apiFetch, ClientApiError } from "@/shared/api-client";
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
import { Label } from "@/components/ui/label";
import { InlineError } from "@/components/design/states";

type Report = { id: string; name: string };

/**
 * Deactivating someone who still has active direct reports would leave them
 * orphaned in the org chart, so the server rejects it — this dialog makes the
 * requirement explicit and collects a replacement manager.
 */
export function DeactivateDialog({
  open,
  onOpenChange,
  employee,
  reports,
  managers,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: { id: string; name: string } | null;
  reports: Report[];
  managers: { id: string; name: string }[];
  onDone: () => void;
}) {
  const [reassignTo, setReassignTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = managers.filter(
    (m) => m.id !== employee?.id && !reports.some((r) => r.id === m.id),
  );
  const needsReassign = reports.length > 0;

  async function confirm() {
    if (!employee) return;
    setBusy(true);
    setError(null);
    try {
      const query = needsReassign ? `?reassign_to=${reassignTo}` : "";
      await apiFetch(`/api/employees/${employee.id}${query}`, { method: "DELETE" });
      onDone();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "Could not deactivate.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Deactivate {employee?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {needsReassign
              ? `${reports.length} active direct report(s) will be reassigned first. The record is kept for reporting history.`
              : "The record is kept for reporting history but the account can no longer sign in."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {needsReassign ? (
          <div className="space-y-2">
            <Label htmlFor="reassign_to">Reassign their team to</Label>
            <div className="relative">
              <select
                id="reassign_to"
                className="h-9 w-full appearance-none rounded-lg border border-input bg-background pr-9 pl-3 text-sm shadow-xs transition-colors duration-150 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25"
                value={reassignTo}
                onChange={(e) => setReassignTo(e.target.value)}
              >
                <option value="">Choose a manager…</option>
                {candidates.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
            </div>
            {/* Named in text so the consequence is legible before the choice. */}
            <p className="text-sm text-muted-foreground">
              {reports.length === 1
                ? `${reports[0].name} will move under this manager.`
                : `${reports.length} people will move under this manager.`}
            </p>
          </div>
        ) : null}

        {error ? <InlineError message={error} /> : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={confirm}
            disabled={busy || (needsReassign && !reassignTo)}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <UserMinus aria-hidden />
            )}
            Deactivate
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
