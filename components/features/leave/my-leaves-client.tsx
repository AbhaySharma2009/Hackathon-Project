"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarPlus } from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import { createClient } from "@/shared/supabase-client";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/design/page-header";
import { EmptyState, ErrorState } from "@/components/design/states";
import { KpiSkeleton, ListSkeleton } from "@/components/design/loaders";
import { BalanceCards } from "@/components/features/leave/balance-cards";
import { LeaveHistory } from "@/components/features/leave/leave-history";
import { LeaveRequestDrawer } from "@/components/features/leave/leave-request-drawer";
import {
  RequestLeaveDialog,
  type BalanceRow,
} from "@/components/features/leave/request-leave-dialog";
import type { MyLeaveRequest } from "@/shared/types";

export function MyLeavesClient({ employeeId }: { employeeId: string }) {
  const [balances, setBalances] = useState<BalanceRow[]>([]);
  const [requests, setRequests] = useState<MyLeaveRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    Promise.all([
      apiFetch<{ data: BalanceRow[] }>(
        `/api/leave-balances/${employeeId}?year=${new Date().getFullYear()}`,
        { signal: controller.signal },
      ),
      apiFetch<{ data: MyLeaveRequest[] }>("/api/leave-requests", {
        signal: controller.signal,
      }),
    ])
      .then(([balanceRes, requestRes]) => {
        setBalances(balanceRes.data);
        setRequests(requestRes.data);
        setError(null);
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [employeeId, nonce]);

  // A manager's decision is a postgres_changes event on the employee's own row,
  // and the balance moves with it, so subscribe to both tables and refetch. This
  // is what makes "approved" appear here without a manual reload.
  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("my-leaves")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "leave_requests",
          filter: `employee_id=eq.${employeeId}`,
        },
        () => setNonce((n) => n + 1),
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "leave_balances",
          filter: `employee_id=eq.${employeeId}`,
        },
        () => setNonce((n) => n + 1),
      )
      .subscribe();

    return () => {
      void channel.unsubscribe();
    };
  }, [employeeId]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Leaves"
        description="Your balances for the year, and every request you have made with the level it reached."
        actions={
          <Button size="lg" onClick={() => setDialogOpen(true)}>
            <CalendarPlus aria-hidden />
            Request leave
          </Button>
        }
      />

      {error ? (
        <ErrorState
          title="We couldn't load your leave"
          message={error}
          onRetry={() => {
            setLoading(true);
            setError(null);
            setNonce((n) => n + 1);
          }}
        />
      ) : (
        <>
          {loading ? <KpiSkeleton /> : <BalanceCards balances={balances} />}

          {loading ? (
            <ListSkeleton count={2} />
          ) : requests.length === 0 ? (
            <EmptyState
              icon={CalendarPlus}
              title="No leave requests yet"
              description="When you request time off it will appear here, with its status and how far through the approval chain it has got."
              action={
                <Button onClick={() => setDialogOpen(true)}>
                  <CalendarPlus aria-hidden />
                  Request leave
                </Button>
              }
            />
          ) : (
            <LeaveHistory requests={requests} onSelect={setSelectedId} />
          )}
        </>
      )}

      {/* These two are siblings, so their keys share one namespace. A bare
          "closed" on both collided whenever the dialog was shut and nothing was
          selected, which React reports as duplicate children. The key is still
          doing its real job — remounting on identity change so the component's
          internal state resets without an effect. */}
      <RequestLeaveDialog
        key={`request-${dialogOpen ? "open" : "closed"}`}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        balances={balances}
        onCreated={refresh}
      />

      <LeaveRequestDrawer
        key={`drawer-${selectedId ?? "closed"}`}
        request={requests.find((r) => r.id === selectedId) ?? null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      />
    </div>
  );
}
