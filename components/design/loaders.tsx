import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/shared/utils";

/**
 * Skeleton presets.
 *
 * Loading used to be a single `animate-pulse bg-muted` block, which made every
 * screen flash a differently-sized grey rectangle. These mirror the real
 * layout so the page does not jump when data arrives, and they are marked
 * `aria-hidden` with a live region supplied by the caller where a screen
 * reader should hear that something is loading.
 */

export function KpiSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="rounded-xl border bg-card p-5">
          <div className="flex items-start justify-between gap-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="size-10 rounded-xl" />
          </div>
          <Skeleton className="mt-4 h-9 w-16" />
          <Skeleton className="mt-2 h-4 w-32" />
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("rounded-xl border bg-card p-5", className)} aria-hidden>
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      <div className="mt-5 space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
      </div>
    </div>
  );
}

export function ListSkeleton({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("space-y-3", className)} aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <CardSkeleton key={index} />
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card" aria-hidden>
      <div className="flex gap-4 border-b bg-muted/40 px-5 py-3.5">
        {Array.from({ length: columns }, (_, index) => (
          <Skeleton key={index} className="h-3.5 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 border-b px-5 py-4 last:border-0">
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton
              key={column}
              className="h-4 flex-1"
              style={{ opacity: 1 - index * 0.12 }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ChartSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("flex h-64 items-end gap-3 rounded-xl border bg-card p-5", className)}
      aria-hidden
    >
      {[45, 70, 38, 82, 55, 66, 30].map((height, index) => (
        <Skeleton key={index} className="flex-1 rounded-t-md" style={{ height: `${height}%` }} />
      ))}
    </div>
  );
}

/** Announced to assistive tech while a region is loading. */
export function LoadingRegion({ label }: { label: string }) {
  return (
    <span role="status" aria-live="polite" className="sr-only">
      {label}
    </span>
  );
}
