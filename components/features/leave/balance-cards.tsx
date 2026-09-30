"use client";

import { AlertTriangle, Infinity as InfinityIcon } from "lucide-react";
import { LEAVE_TYPE_LABEL } from "@/server/leave";
import { cn } from "@/shared/utils";
import type { BalanceRow } from "@/components/features/leave/request-leave-dialog";

/** One block per allocated day, so the balance reads at a glance. */
function DayBlocks({ used, allocated }: { used: number; allocated: number }) {
  // Beyond this the blocks are too thin to distinguish, so the bar takes over.
  const showBlocks = allocated > 0 && allocated <= 16;
  if (!showBlocks) return null;
  return (
    <div
      className="flex gap-1"
      role="img"
      aria-label={`${used} of ${allocated} days used`}
    >
      {Array.from({ length: allocated }, (_, index) => (
        <span
          key={index}
          className={cn(
            "h-6 flex-1 rounded-[3px] transition-colors",
            index < used ? "bg-primary" : "bg-primary/12",
          )}
        />
      ))}
    </div>
  );
}

/**
 * A leave balance card.
 *
 * The old card led with "days left" and a 6px progress bar, which made every
 * type look identical and hid how few days were actually left. This version puts
 * the remaining count and the allocation side by side, draws the balance as one
 * block per day, and only escalates to a warning when there is genuinely little
 * left — exhausted is stated plainly rather than shown in red.
 */
export function BalanceCards({ balances }: { balances: BalanceRow[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {balances.map((balance) => {
        const allocated = Number(balance.allocated);
        const used = Number(balance.used);
        const remaining = Number(balance.remaining);
        const uncapped = balance.leave_type === "unpaid";
        const exhausted = !uncapped && remaining <= 0;
        const low = !uncapped && remaining > 0 && remaining <= 2;

        return (
          <div
            key={balance.id}
            data-slot="balance-card"
            data-state={exhausted ? "exhausted" : low ? "low" : "ok"}
            className={cn(
              "group/balance rounded-xl border bg-card p-5 transition-[box-shadow,border-color,transform] duration-200 hover:-translate-y-0.5 hover:shadow-md",
              exhausted && "border-dashed",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold">{LEAVE_TYPE_LABEL[balance.leave_type]}</p>
              {exhausted ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-2xs font-semibold text-muted-foreground">
                  <AlertTriangle className="size-3" aria-hidden />
                  Used up
                </span>
              ) : low ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-2xs font-semibold text-warning-foreground">
                  Running low
                </span>
              ) : null}
            </div>

            <p className="mt-3 flex items-baseline gap-1.5">
              <span className="text-kpi font-semibold tabular text-foreground">
                {uncapped ? <InfinityIcon className="size-8" aria-hidden /> : remaining}
              </span>
              <span className="text-sm text-muted-foreground">
                {uncapped ? "unlimited" : `of ${allocated} left`}
              </span>
            </p>

            {uncapped ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Tracked separately — never capped.
              </p>
            ) : (
              <div className="mt-4 space-y-2.5">
                <DayBlocks used={used} allocated={allocated} />
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{used} used</span>
                  <span className="tabular font-medium text-foreground">
                    {allocated > 0 ? Math.round((used / allocated) * 100) : 0}%
                  </span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
