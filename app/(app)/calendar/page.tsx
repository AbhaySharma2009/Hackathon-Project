"use client";

import { useEmployee } from "@/components/providers/session-provider";
import dynamic from "next/dynamic";
import { LoadingRegion } from "@/components/design/loaders";
import { Skeleton } from "@/components/ui/skeleton";

const CalendarClient = dynamic(
  () => import("@/components/features/calendar/calendar-client").then((m) => m.CalendarClient),
  {
    loading: () => (
      <div className="space-y-6" aria-hidden>
        <LoadingRegion label="Loading the calendar" />
        <div className="grid grid-cols-7 border-b bg-muted/40">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, index) => (
            <div
              key={day}
              className={`border-r px-2 py-2 last:border-r-0 ${(index === 0 || index === 6) && "bg-muted/70"}`}
            >
              <Skeleton className="h-3 w-7" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {Array.from({ length: 42 }).map((_, index) => {
            const column = index % 7;
            const week = Math.floor(index / 7);
            const inHintedBar = week === 1 && column < 4;
            return (
              <div
                key={index}
                className={`flex h-20 flex-col gap-1.5 border-b border-r border-border/70 p-1.5 last:border-r-0 sm:h-24 ${(column === 0 || column === 6) && "bg-muted/40"}`}
              >
                <Skeleton className="size-7 shrink-0 rounded-full" />
                {inHintedBar ? (
                  <Skeleton className="mt-auto h-7 w-full rounded-md" style={{ opacity: 1 - column * 0.15 }} />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    ),
    ssr: false,
  },
);


export default function CalendarPage() {
  const employee = useEmployee();

  if (!employee) return null;

  return <CalendarClient />;
}