"use client";

/**
 * The approval inbox.
 *
 * The layout is a card per request rather than a table. The table had eight
 * columns — including a full approval chain, an expandable impact panel and two
 * action buttons — which forced the reason to two clamped lines at 12px and left
 * the decision buttons squeezed into the last cell. A card gives every field room
 * to be readable and puts the two actions where the eye lands last.
 *
 * Nothing about the decision itself changed: the same two endpoints, the same
 * confirmation dialog, the same realtime refetch.
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCheck, Inbox, Sparkles, X } from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import { INBOX_TABS, LEAVE_TYPE_LABEL, type InboxTab } from "@/server/leave";
import { createClient } from "@/shared/supabase-client";
import type { ApprovalRequest } from "@/shared/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToastViewport, useToast } from "@/components/ui/toast";
import { DecisionDialog } from "@/components/features/approvals/decision-dialog";
import { ApprovalTimeline } from "@/components/features/approvals/approval-timeline";
import { LeaveImpactPanel } from "@/components/features/approvals/leave-impact-panel";
import { PageHeader } from "@/components/design/page-header";
import { EmptyState, ErrorState } from "@/components/design/states";
import { ListSkeleton } from "@/components/design/loaders";
import { StatusBadge } from "@/components/design/status-badge";
import { cn } from "@/shared/utils";

type Counts = { pending: number; approved: number; rejected: number; approval_blocked: number };

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

/** Whoever holds the active step, for "waiting on <name>" copy. */
function activeApproverName(request: ApprovalRequest) {
  return request.approval_chain.find((step) => step.is_current)?.approver_name ?? null;
}

export function ApprovalsClient() {
  const [rows, setRows] = useState<ApprovalRequest[]>([]);
  const [counts, setCounts] = useState<Counts>({
    pending: 0,
    approved: 0,
    rejected: 0,
    approval_blocked: 0,
  });
  const [tab, setTab] = useState<InboxTab>("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The request whose Leave Impact panel is open. Null means every panel is
  // closed, so at most one is ever mounted — the panel fetches per request, so
  // mounting all of them would fire a query per row on every load.
  const [impactFor, setImpactFor] = useState<string | null>(null);
  const [target, setTarget] = useState<{ request: ApprovalRequest; decision: "approve" | "reject" } | null>(
    null,
  );
  const { toasts, toast, dismiss } = useToast();
  const [viewerIsHr, setViewerIsHr] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await apiFetch<{
      data: ApprovalRequest[];
      meta: { counts: Counts; viewer: { id: string; app_role: string } };
    }>("/api/approvals", { signal });
    setRows(response.data);
    setCounts(response.meta.counts);
    setViewerIsHr(response.meta.viewer.app_role === "hr");
    setError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal)
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [load]);

  // A decision made by a colleague, or a new request from a report, should show
  // up without a manual reload. The refetch is the source of truth; Realtime is
  // only the signal that something changed.
  useEffect(() => {
    const channel = createClient()
      .channel("approvals-inbox")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "leave_requests" },
        () => {
          load().catch(() => {
            /* a failed background refresh must not blank the list */
          });
        },
      )
      .subscribe();

    return () => {
      void channel.unsubscribe();
    };
  }, [load]);

  const refresh = useCallback(async () => {
    try {
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [load]);

  /**
   * Phase 3.5: the pending tab is "what is waiting on YOU", not "what your team
   * submitted". A department head therefore sees a long request only while the
   * department-head step is the active one — the moment it moves to HR it leaves
   * their tab and appears in HR's, which is the point of a handover.
   *
   * A blocked request has no active step, so it can never be `viewer_can_decide`
   * for a manager. Only HR can clear one, so only HR gets it in their pending tab.
   */
  const isAwaitingViewer = (row: ApprovalRequest) =>
    row.status === "approval_blocked"
      ? viewerIsHr
      : row.status === "pending" && row.viewer_can_decide;

  const visible =
    tab === "pending" ? rows.filter(isAwaitingViewer) : rows.filter((row) => row.status === tab);
  const decided = tab !== "pending";
  // A signed-off request keeps its full chain visible, including who signed before
  // the current viewer.
  const blocked = visible.filter((row) => row.status === "approval_blocked");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approvals"
        description="Requests waiting on your decision, and the decisions you have already made. A request moves to the next approver the moment you settle it."
      />

      <div
        role="tablist"
        aria-label="Request status"
        className="flex flex-wrap gap-1.5 border-b pb-3"
      >
        {INBOX_TABS.map((value) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              "inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium capitalize transition-colors duration-150",
              tab === value
                ? "border-primary/30 bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {value}
            <span className="tabular rounded-full bg-background/70 px-1.5 text-xs">
              {counts[value]}
            </span>
          </button>
        ))}
      </div>

      {/* A blocked request is real and visible, so the reason has to be on screen
          rather than behind a log. HR is the only role that can clear one. */}
      {blocked.length > 0 ? (
        <div className="space-y-2 rounded-xl border border-warning/40 bg-warning/5 p-4">
          <div className="flex items-center gap-2">
            <X className="size-4 text-warning-foreground" aria-hidden />
            <p className="text-sm font-semibold">
              {blocked.length} request{blocked.length === 1 ? "" : "s"} could not be routed for
              approval
            </p>
          </div>
          {blocked.map((row) => (
            <p key={row.id} className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{row.employee_name}</span> —{" "}
              {row.blocked_reason}
            </p>
          ))}
        </div>
      ) : null}

      {error ? (
        <ErrorState
          title="We couldn't load your approvals"
          message={error}
          onRetry={() => {
            setLoading(true);
            setError(null);
            void refresh().finally(() => setLoading(false));
          }}
        />
      ) : loading ? (
        <ListSkeleton count={3} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={tab === "pending" ? CheckCheck : Inbox}
          title={
            tab === "pending"
              ? "You're all caught up"
              : tab === "approved"
                ? "You haven't approved anything yet"
                : "You haven't rejected anything yet"
          }
          description={
            tab === "pending"
              ? "New leave requests appear here while you hold the next signature, and move to the next approver as soon as you decide them."
              : `Requests you ${tab === "approved" ? "approve" : "reject"} will be listed here.`
          }
        />
      ) : (
        <ul className="space-y-4">
          {visible.map((request) => (
            <li key={request.id}>
              <article className="overflow-hidden rounded-xl border bg-card transition-[box-shadow,border-color] duration-200 hover:border-primary/25 hover:shadow-md">
                <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-start lg:justify-between">
                  {/* Who and what */}
                  <div className="flex min-w-0 gap-3.5">
                    <Avatar size="lg">
                      {request.employee_photo ? (
                        <AvatarImage src={request.employee_photo} alt="" />
                      ) : (
                        <AvatarFallback>{initials(request.employee_name)}</AvatarFallback>
                      )}
                    </Avatar>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-card-title font-semibold">
                          {request.employee_name}
                        </h2>
                        <StatusBadge status={request.status} />
                      </div>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {request.employee_role} · {request.employee_department}
                      </p>
                      <p className="mt-2.5 flex flex-wrap items-center gap-2 text-sm">
                        <Badge variant="outline">
                          {LEAVE_TYPE_LABEL[request.leave_type]}
                        </Badge>
                        <span className="font-medium text-foreground">
                          {formatRange(request.start_date, request.end_date)}
                        </span>
                        <span className="tabular text-muted-foreground">
                          {request.days} working day{Number(request.days) === 1 ? "" : "s"}
                        </span>
                      </p>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
                    {decided ? (
                      <span className="text-sm text-muted-foreground">
                        Decided{" "}
                        {request.decided_at
                          ? new Date(request.decided_at).toLocaleDateString("en-IN", {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })
                          : "—"}
                      </span>
                    ) : request.viewer_can_decide ? (
                      <>
                        <Button
                          onClick={() => setTarget({ request, decision: "approve" })}
                        >
                          <CheckCheck aria-hidden />
                          Approve
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => setTarget({ request, decision: "reject" })}
                        >
                          Reject
                        </Button>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Waiting on {activeApproverName(request) ?? "the next approver"}
                      </p>
                    )}
                  </div>
                </div>

                {/* Reason + chain + impact */}
                <div className="grid gap-5 border-t bg-muted/25 p-5 lg:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="min-w-0 space-y-4">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Reason given
                      </p>
                      <p className="mt-1 leading-relaxed text-foreground">
                        {request.reason || "No reason was provided."}
                      </p>
                    </div>

                    <div>
                      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Approval progress
                      </p>
                      <ApprovalTimeline
                        steps={request.approval_chain}
                        status={request.status}
                      />
                    </div>

                    {request.manager_comment ? (
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {decided ? "Comment" : "Latest comment"}
                        </p>
                        <p className="mt-1 leading-relaxed text-muted-foreground">
                          {request.manager_comment}
                        </p>
                      </div>
                    ) : null}

                    <div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="px-0 text-primary hover:bg-transparent hover:text-primary/80"
                        onClick={() =>
                          setImpactFor((current) => (current === request.id ? null : request.id))
                        }
                        aria-expanded={impactFor === request.id}
                      >
                        <Sparkles className="size-4" aria-hidden />
                        {impactFor === request.id ? "Hide leave impact" : "Show leave impact"}
                      </Button>
                      {impactFor === request.id ? (
                        <div className="mt-3 max-w-xl">
                          <LeaveImpactPanel requestId={request.id} />
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="shrink-0 text-sm text-muted-foreground lg:w-44 lg:text-right">
                    <p>
                      Requested{" "}
                      {new Date(request.created_at).toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </p>
                    <p className="mt-1">
                      {request.current_approval_level
                        ? `Level ${request.current_approval_level} of ${request.approval_chain.length}`
                        : "Chain complete"}
                    </p>
                  </div>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}

      <DecisionDialog
        key={target ? `${target.request.id}-${target.decision}` : "closed"}
        request={target?.request ?? null}
        decision={target?.decision ?? "approve"}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        onDecided={async (message, tone) => {
          toast({
            tone,
            title: tone === "success" ? "Decision recorded" : "Could not decide",
            description: message,
          });
          await refresh();
        }}
      />

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
