"use client";

import { useEmployee } from "@/components/providers/session-provider";
import dynamic from "next/dynamic";
import { LoadingRegion } from "@/components/design/loaders";
import { Skeleton } from "@/components/ui/skeleton";

const OrgChartClient = dynamic(
  () => import("@/components/features/org-chart/org-chart-client").then((m) => m.OrgChartClient),
  {
    loading: () => (
      <div className="flex h-[680px] flex-col items-center justify-center gap-4" aria-hidden>
        <LoadingRegion label="Loading the org chart" />
        <div className="flex flex-col items-center gap-3">
          <Skeleton className="size-12 rounded-full" />
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-3 w-28" />
        </div>
        <div className="mt-6 grid grid-cols-3 gap-8 opacity-60">
          {[0, 1, 2].map((column) => (
            <div key={column} className="flex flex-col items-center gap-8">
              <Skeleton className="h-44 w-62 rounded-2xl" />
              <Skeleton className="h-44 w-62 rounded-2xl" />
            </div>
          ))}
        </div>
      </div>
    ),
    ssr: false,
  },
);


export default function OrgChartPage() {
  const employee = useEmployee();

  if (!employee) return null;

  return <OrgChartClient />;
}