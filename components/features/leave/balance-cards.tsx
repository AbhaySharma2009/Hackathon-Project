"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { LEAVE_TYPE_LABEL } from "@/server/leave";
import type { BalanceRow } from "@/components/features/leave/request-leave-dialog";

export function BalanceCards({ balances }: { balances: BalanceRow[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {balances.map((balance) => {
        const allocated = Number(balance.allocated);
        const used = Number(balance.used);
        const remaining = Number(balance.remaining);
        const percent = allocated > 0 ? Math.round((used / allocated) * 100) : 0;
        const low = balance.leave_type !== "unpaid" && remaining <= 2;

        return (
          <Card key={balance.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {LEAVE_TYPE_LABEL[balance.leave_type]}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-3xl font-semibold tabular-nums">
                {remaining}
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  days left
                </span>
              </p>

              {balance.leave_type === "unpaid" ? (
                <p className="text-xs text-muted-foreground">
                  No cap — tracked separately, never limited.
                </p>
              ) : (
                <>
                  <Progress
                    value={percent}
                    aria-label={`${used} of ${allocated} ${balance.leave_type} days used`}
                    className="h-1.5"
                  />
                  <p className="text-xs text-muted-foreground">
                    {used} of {allocated} used
                    {low ? (
                      <span className="ml-1 font-medium text-destructive">· running low</span>
                    ) : null}
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
