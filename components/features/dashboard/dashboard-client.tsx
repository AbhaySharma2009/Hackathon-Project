"use client";

/**
 * The employee dashboard.
 *
 * It reads only from the endpoints the employee already owns — their own
 * balances, their own requests, and (for managers and HR) their own approval
 * inbox. Nothing new is requested and no new query is introduced, so RLS and the
 * role gates are exactly as strict as before; this component only decides what
 * to show with the data it is already given.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CalendarCheck,
  CalendarDays,
  CalendarPlus,
  ClipboardCheck,
  Clock,
  History,
  Plane,
  Users,
  Wallet,
} from "lucide-react";
import { apiFetch } from "@/shared/api-client";
import { LEAVE_TYPE_LABEL } from "@/server/leave";
import type { ApprovalRequest, MyLeaveRequest } from "@/shared/types";
import { KpiCard } from "@/components/design/kpi-card";
import { PageHeader } from "@/components/design/page-header";
import { StatusBadge } from "@/components/design/status-badge";
import { EmptyState, ErrorState } from "@/components/design/states";
import { KpiSkeleton, ListSkeleton } from "@/components/design/loaders";
import { BalanceCards } from "@/components/features/leave/balance-cards";
import { RequestLeaveDialog, type BalanceRow } from "@/components/features/leave/request-leave-dialog";
import { AlertList } from "@/components/features/alerts/alert-list";
import { ApprovalStageLine } from "@/components/features/approvals/approval-timeline";
import { Button } from "@/components/ui/button";
import { LinkButton } from "@/components/design/link-button";

type Counts = { pending: number; approved: number; rejected: number; approval_blocked: number };

function formatRange(start: string, end: string) {
  const format = (value: string) =>
    new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return start === end ? format(start) : `${format(start)} – ${format(end)}`;
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** Whole days from today to a `YYYY-MM-DD` date, ignoring the time of day. */
function daysUntil(date: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${date}T00:00:00`);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

export function DashboardClient({
  employeeId,
  name,
  appRole,
}: {
  employeeId: string;
  name: string;
  appRole: "employee" | "manager" | "hr";
}) {
  const [balances, setBalances] = useState<BalanceRow[]>([]);
  const [requests, setRequests] = useState<MyLeaveRequest[]>([]);
  const [inbox, setInbox] = useState<{ rows: ApprovalRequest[]; counts: Counts } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      // The inbox endpoint is only fetched for the roles the server accepts. An
      // employee asking for it would get 403, and an avoidable error banner on
      // the first screen is not a good trade.
      const [balanceRes, requestRes, inboxRes] = await Promise.all([
        apiFetch<{ data: BalanceRow[] }>(
          `/api/leave-balances/${employeeId}?year=${new Date().getFullYear()}`,
          { signal },
        ),
        apiFetch<{ data: MyLeaveRequest[] }>("/api/leave-requests", { signal }),
        appRole === "employee"
          ? Promise.resolve(null)
          : apiFetch<{ data: ApprovalRequest[]; meta: { counts: Counts } }>("/api/approvals", {
              signal,
            }),
      ]);

      setBalances(balanceRes.data);
      setRequests(requestRes.data);
      setInbox(inboxRes ? { rows: inboxRes.data, counts: inboxRes.meta.counts } : null);
      setError(null);
    },
    [employeeId, appRole],
  );

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

  const stats = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const capless = balances.filter((b) => b.leave_type !== "unpaid");
    const available = capless.reduce((sum, b) => sum + Number(b.remaining), 0);
    const inReview = requests.filter((r) => r.status === "pending" || r.status === "approval_blocked");
    const approvedThisYear = requests.filter(
      (r) => r.status === "approved" && r.start_date.startsWith(String(new Date().getFullYear())),
    );
    const upcoming = requests
      .filter((r) => (r.status === "approved" || r.status === "pending") && r.end_date >= today)
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
    const recent = [...requests]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 5);
    return { available, inReview, approvedThisYear, upcoming, recent, today };
  }, [balances, requests]);

  const firstName = name.split(" ")[0];
  const nextLeave = stats.upcoming[0];
  const awaitingMe = inbox
    ? inbox.rows.filter((row) => row.status === "pending" && row.viewer_can_decide).length
    : 0;

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Dashboard" />
        <ErrorState
          title="We couldn't load your dashboard"
          message={error}
          onRetry={() => {
            setLoading(true);
            setError(null);
            void load()
              .catch((err: Error) => setError(err.message))
              .finally(() => setLoading(false));
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        description={
          nextLeave
            ? `Your next time off starts ${
                nextLeave.start_date === stats.today
                  ? "today"
                  : `in ${daysUntil(nextLeave.start_date)} day${daysUntil(nextLeave.start_date) === 1 ? "" : "s"}`
              } — ${LEAVE_TYPE_LABEL[nextLeave.leave_type]}, ${formatRange(nextLeave.start_date, nextLeave.end_date)}.`
            : "You have no upcoming leave booked. Everything else is up to date."
        }
        actions={
          <Button size="lg" onClick={() => setDialogOpen(true)}>
            <CalendarPlus aria-hidden />
            Request leave
          </Button>
        }
      />

      {loading ? (
        <KpiSkeleton />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            index={0}
            icon={Wallet}
            label="Days available"
            value={stats.available}
            hint={`Across ${balances.filter((b) => b.leave_type !== "unpaid").length} leave types this year`}
            href="/my-leaves"
          />
          <KpiCard
            index={1}
            icon={Clock}
            tone={stats.inReview.length > 0 ? "info" : "neutral"}
            label="In review"
            value={stats.inReview.length}
            hint={
              stats.inReview.length > 0
                ? "Waiting on an approver"
                : "Nothing waiting on approval"
            }
            href="/my-leaves"
          />
          <KpiCard
            index={2}
            icon={CalendarCheck}
            tone="success"
            label="Approved this year"
            value={stats.approvedThisYear.reduce((sum, r) => sum + r.days, 0)}
            hint={`${stats.approvedThisYear.length} request${stats.approvedThisYear.length === 1 ? "" : "s"} approved`}
          />
          {appRole === "employee" ? (
            <KpiCard
              index={3}
              icon={Users}
              tone="neutral"
              label="Your team"
              value="—"
              hint="See who is away on the calendar"
              href="/calendar"
            />
          ) : (
            <KpiCard
              index={3}
              icon={ClipboardCheck}
              tone={awaitingMe > 0 ? "warning" : "neutral"}
              label="Awaiting your approval"
              value={awaitingMe}
              hint={awaitingMe > 0 ? "Requests need your decision" : "You're all caught up"}
              href="/approvals"
            />
          )}
        </div>
      )}

      {/* Quick actions: the three things an employee actually came here to do. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => setDialogOpen(true)}>
          <CalendarPlus aria-hidden />
          Request leave
        </Button>
        <LinkButton href="/calendar" variant="outline">
          <CalendarDays aria-hidden />
          Team calendar
        </LinkButton>
        <LinkButton href="/directory" variant="outline">
          <Users aria-hidden />
          Directory
        </LinkButton>
        {appRole !== "employee" ? (
          <LinkButton href="/hr-dashboard" variant="outline">
            <ClipboardCheck aria-hidden />
            Analytics
          </LinkButton>
        ) : null}
      </div>

      <section className="space-y-4">
        <div className="flex items-end justify-between gap-3">
          <h2 className="text-section-title font-semibold">Leave balance</h2>
          <Link
            href="/my-leaves"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            All my leaves
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
        {loading ? (
          <KpiSkeleton count={4} />
        ) : balances.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title="No balances allocated yet"
            description="Once HR allocates your leave for the year it will appear here."
          />
        ) : (
          <BalanceCards balances={balances} />
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-4">
          <h2 className="text-section-title font-semibold">Upcoming leave</h2>
          {loading ? (
            <ListSkeleton count={2} />
          ) : stats.upcoming.length === 0 ? (
            <EmptyState
              icon={Plane}
              title="Nothing booked yet"
              description="Approved and pending leave appears here with its dates, so you always know what is coming."
              action={
                <Button variant="outline" onClick={() => setDialogOpen(true)}>
                  <CalendarPlus aria-hidden />
                  Request leave
                </Button>
              }
            />
          ) : (
            <ul className="space-y-3">
              {stats.upcoming.slice(0, 4).map((request) => (
                <li
                  key={request.id}
                  className="rounded-xl border bg-card p-4 transition-[box-shadow,border-color] duration-200 hover:border-primary/25 hover:shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-card-title font-semibold">
                        {LEAVE_TYPE_LABEL[request.leave_type]} ·{" "}
                        {formatRange(request.start_date, request.end_date)}
                      </p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {request.days} working day{request.days === 1 ? "" : "s"} ·{" "}
                        {daysUntil(request.start_date) === 0
                          ? "starts today"
                          : `starts in ${daysUntil(request.start_date)} day${daysUntil(request.start_date) === 1 ? "" : "s"}`}
                      </p>
                    </div>
                    <StatusBadge status={request.status} />
                  </div>
                  {request.approval_chain.length > 0 ? (
                    <div className="mt-3">
                      <ApprovalStageLine steps={request.approval_chain} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-4">
          <div className="flex items-end justify-between gap-3">
            <h2 className="text-section-title font-semibold">Attention needed</h2>
            {appRole !== "employee" ? (
              <Link
                href="/alerts"
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                All alerts
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            ) : null}
          </div>
          <AlertList compact />
        </section>
      </div>

      <section className="space-y-4">
        <h2 className="text-section-title font-semibold">Recent activity</h2>
        {loading ? (
          <ListSkeleton count={3} />
        ) : stats.recent.length === 0 ? (
          <EmptyState
            icon={History}
            title="No activity yet"
            description="Requests you make, and the decisions made on them, will be listed here."
          />
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {stats.recent.map((request) => (
              <li key={request.id}>
                <Link
                  href="/my-leaves"
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5 transition-colors hover:bg-accent/50"
                >
                  <StatusBadge status={request.status} />
                  <span className="text-sm font-medium">
                    {LEAVE_TYPE_LABEL[request.leave_type]}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {formatRange(request.start_date, request.end_date)} · {request.days}d
                  </span>
                  <span className="ml-auto text-sm text-muted-foreground">
                    Requested{" "}
                    {new Date(request.created_at).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                    })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <RequestLeaveDialog
        key={`request-${dialogOpen ? "open" : "closed"}`}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        balances={balances}
        onCreated={() => void load()}
      />
    </div>
  );
}
