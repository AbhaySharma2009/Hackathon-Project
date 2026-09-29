"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarPlus, Inbox } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BalanceCards } from "@/components/leave/balance-cards";
import { LeaveHistory } from "@/components/leave/leave-history";
import { LeaveRequestDrawer } from "@/components/leave/leave-request-drawer";
import {
  RequestLeaveDialog,
  type BalanceRow,
} from "@/components/leave/request-leave-dialog";
import type { LeaveRequest } from "@/lib/types";

export function MyLeavesClient({ employeeId }: { employeeId: string }) {
  const [balances, setBalances] = useState<BalanceRow[]>([]);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
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
      apiFetch<{ data: LeaveRequest[] }>("/api/leave-requests", {
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My Leaves</h1>
          <p className="text-sm text-muted-foreground">
            Your balances and every request you have made.
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <CalendarPlus className="size-4" aria-hidden />
          Request leave
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-lg bg-muted" aria-hidden />
          ))}
        </div>
      ) : (
        <BalanceCards balances={balances} />
      )}

      {loading ? (
        <div className="h-64 animate-pulse rounded-lg bg-muted" aria-hidden />
      ) : requests.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Inbox className="size-8 text-muted-foreground" aria-hidden />
            <div>
              <p className="font-medium">No leave requests yet</p>
              <p className="text-sm text-muted-foreground">
                When you request time off it will appear here with its status.
              </p>
            </div>
            <Button variant="outline" onClick={() => setDialogOpen(true)}>
              Request leave
            </Button>
          </CardContent>
        </Card>
      ) : (
        <LeaveHistory requests={requests} onSelect={setSelectedId} />
      )}

      <RequestLeaveDialog
        key={dialogOpen ? "open" : "closed"}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        balances={balances}
        onCreated={refresh}
      />

      <LeaveRequestDrawer
        key={selectedId ?? "closed"}
        request={requests.find((r) => r.id === selectedId) ?? null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      />
    </div>
  );
}
