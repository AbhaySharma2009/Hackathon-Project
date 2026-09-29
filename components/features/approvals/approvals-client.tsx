"use client";

import { useCallback, useEffect, useState } from "react";
import { Inbox } from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import { INBOX_TABS, LEAVE_TYPE_LABEL, type InboxTab } from "@/server/leave";
import { createClient } from "@/shared/supabase-client";
import type { ApprovalRequest } from "@/shared/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToastViewport, useToast } from "@/components/ui/toast";
import { DecisionDialog } from "@/components/features/approvals/decision-dialog";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  approved: "default",
  rejected: "destructive",
  cancelled: "outline",
};

type Counts = { pending: number; approved: number; rejected: number };

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

export function ApprovalsClient() {
  const [rows, setRows] = useState<ApprovalRequest[]>([]);
  const [counts, setCounts] = useState<Counts>({ pending: 0, approved: 0, rejected: 0 });
  const [tab, setTab] = useState<InboxTab>("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<{ request: ApprovalRequest; decision: "approve" | "reject" } | null>(
    null,
  );
  const { toasts, toast, dismiss } = useToast();

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await apiFetch<{ data: ApprovalRequest[]; meta: { counts: Counts } }>(
      "/api/approvals",
      { signal },
    );
    setRows(response.data);
    setCounts(response.meta.counts);
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

  const visible = rows.filter((row) => row.status === tab);
  const decided = tab !== "pending";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          Pending leave requests from your team, and the decisions you have made.
        </p>
      </div>

      <div role="tablist" aria-label="Request status" className="flex gap-1 border-b">
        {INBOX_TABS.map((value) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={
              tab === value
                ? "border-b-2 border-foreground px-3 py-2 text-sm font-medium capitalize"
                : "border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            }
          >
            {value}
            <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-xs tabular-nums">
              {counts[value]}
            </span>
          </button>
        ))}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {loading ? (
        <div className="h-64 animate-pulse rounded-lg bg-muted" aria-hidden />
      ) : visible.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Inbox className="size-8 text-muted-foreground" aria-hidden />
            <div>
              <p className="font-medium">
                {tab === "pending" ? "Nothing waiting on you" : `No ${tab} requests yet`}
              </p>
              <p className="text-sm text-muted-foreground">
                {tab === "pending"
                  ? "New requests from your team will appear here as soon as they are submitted."
                  : `Requests you ${tab === "approved" ? "approve" : "reject"} will be listed here.`}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead className="text-right">Days</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Submitted</TableHead>
                  {decided ? <TableHead>Decision</TableHead> : <TableHead>Action</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((request) => (
                  <TableRow key={request.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Avatar size="sm">
                          {request.employee_photo ? (
                            <AvatarImage src={request.employee_photo} alt="" />
                          ) : (
                            <AvatarFallback>{initials(request.employee_name)}</AvatarFallback>
                          )}
                        </Avatar>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{request.employee_name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {request.employee_department}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{LEAVE_TYPE_LABEL[request.leave_type]}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatRange(request.start_date, request.end_date)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{request.days}</TableCell>
                    <TableCell className="max-w-64">
                      <p className="line-clamp-2 text-xs text-muted-foreground">{request.reason}</p>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(request.created_at).toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </TableCell>
                    <TableCell>
                      {decided ? (
                        <div className="space-y-1">
                          <Badge variant={STATUS_VARIANT[request.status]}>{request.status}</Badge>
                          {request.manager_comment ? (
                            <p className="max-w-56 text-xs text-muted-foreground">
                              {request.manager_comment}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => setTarget({ request, decision: "approve" })}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => setTarget({ request, decision: "reject" })}
                          >
                            Reject
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <DecisionDialog
        key={target ? `${target.request.id}-${target.decision}` : "closed"}
        request={target?.request ?? null}
        decision={target?.decision ?? "approve"}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        onDecided={async (message, tone) => {
          toast({ tone, title: tone === "success" ? "Decision recorded" : "Could not decide", description: message });
          await refresh();
        }}
      />

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
