"use client";

/**
 * Leave Impact — the cost of saying yes, shown before the decision.
 *
 * Every figure here is the output of `get_leave_impact`, which computes the team
 * as it would be with the request granted. The component deliberately does not
 * recompute availability or re-derive the risk band: it renders what the
 * database decided, so the callout and the database can never disagree.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Users } from "lucide-react";
import { apiFetch, ClientApiError } from "@/shared/api-client";
import { RISK_CLASS, RISK_LABEL, describeImpact, type RiskLevel } from "@/server/insights";
import type { LeaveImpact } from "@/shared/types";
import { Badge } from "@/components/ui/badge";

function formatDate(value: string) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

type PanelState =
  | { requestId: string; status: "ready"; impact: LeaveImpact }
  | { requestId: string; status: "error"; message: string };

/**
 * The state is tagged with the request it belongs to, so the panel is derived
 * from a comparison rather than reset inside the effect. That keeps a stale
 * payload from a previous request on screen while the new one loads.
 */
export function LeaveImpactPanel({ requestId }: { requestId: string }) {
  const [state, setState] = useState<PanelState | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    apiFetch<{ data: LeaveImpact }>(`/api/leave-requests/${requestId}/impact`, {
      signal: controller.signal,
    })
      .then((response) =>
        setState({ requestId, status: "ready", impact: response.data }),
      )
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setState({
          requestId,
          status: "error",
          message:
            err instanceof ClientApiError
              ? err.message
              : "Could not work out the team impact of this request.",
        });
      });

    return () => controller.abort();
  }, [requestId]);

  if (!state || state.requestId !== requestId) {
    return (
      <div
        data-slot="leave-impact"
        data-state="loading"
        className="flex items-center gap-2 rounded-lg border p-3.5 text-sm text-muted-foreground"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Working out the team impact…
      </div>
    );
  }

  // A failure here must never block the decision itself, so the panel degrades
  // to an explanation instead of hiding the approve button.
  if (state.status === "error") {
    return (
      <div
        data-slot="leave-impact"
        data-state="error"
        className="rounded-lg border border-dashed p-3.5 text-sm text-muted-foreground"
      >
        <p className="font-medium text-foreground">Leave Impact</p>
        <p className="mt-0.5 text-sm">{state.message}</p>
      </div>
    );
  }

  const impact = state.impact;
  const risk = impact.risk as RiskLevel | null;

  return (
    <div
      data-slot="leave-impact"
      data-state="ready"
      data-risk={risk ?? "none"}
      data-team-size={impact.team_size}
      data-overlap-count={impact.already_on_leave}
      data-worst-pct={impact.worst_day_availability_pct ?? ""}
      className={`space-y-3.5 rounded-lg border p-3.5 text-sm ${risk ? RISK_CLASS[risk] : "bg-muted/40"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-medium">
          {risk === "high" || risk === "medium" ? (
            <AlertTriangle className="size-4" aria-hidden />
          ) : (
            <CheckCircle2 className="size-4" aria-hidden />
          )}
          Leave Impact
        </p>
        {risk ? (
          <Badge variant="outline" className={RISK_CLASS[risk]}>
            {RISK_LABEL[risk]}
          </Badge>
        ) : null}
      </div>

      <p className="leading-relaxed">{describeImpact(impact)}</p>

      <dl className="grid grid-cols-3 gap-3">
        <div>
          <dt className="text-xs opacity-75">Team size</dt>
          <dd className="tabular mt-0.5 flex items-center gap-1 text-base font-semibold">
            <Users className="size-4" aria-hidden />
            {impact.team_size}
          </dd>
        </div>
        <div>
          <dt className="text-xs opacity-75">Working days</dt>
          <dd className="tabular mt-0.5 text-base font-semibold">{impact.working_days}</dd>
        </div>
        <div>
          <dt className="text-xs opacity-75">Others away</dt>
          <dd className="tabular mt-0.5 text-base font-semibold">{impact.already_on_leave}</dd>
        </div>
      </dl>

      {impact.overlapping_leave.length > 0 ? (
        <ul className="space-y-1.5 border-t pt-3 text-sm">
          {impact.overlapping_leave.map((overlap) => (
            <li key={overlap.employee_id} className="flex justify-between gap-2">
              <span className="font-medium">{overlap.name}</span>
              <span className="tabular-nums opacity-80">
                {formatDate(overlap.start_date)} – {formatDate(overlap.end_date)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {impact.worst_date ? (
        <p className="border-t pt-3 text-sm">
          Tightest day is{" "}
          <span className="font-medium">{formatDate(impact.worst_date)}</span> —{" "}
          <span className="tabular-nums">{impact.worst_day_availability_pct}% available</span>.
        </p>
      ) : null}
    </div>
  );
}
