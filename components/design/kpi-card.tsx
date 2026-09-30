import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/shared/utils";

/**
 * The interactive KPI tile used across the dashboard and the HR dashboard.
 *
 * Two rules kept it from becoming decoration:
 *   - the number is the loudest thing on the card and the label is the second,
 *     with the context line last and quietest;
 *   - it is a real control only when `href`/`onClick` is supplied, so a
 *     non-interactive tile never advertises itself as clickable.
 */
const TONES = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/12 text-success-foreground",
  warning: "bg-warning/15 text-warning-foreground",
  danger: "bg-destructive/10 text-destructive",
  info: "bg-info/12 text-info-foreground",
  neutral: "bg-muted text-muted-foreground",
} as const;

export type KpiTone = keyof typeof TONES;

export function KpiCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "primary",
  href,
  onClick,
  className,
  index = 0,
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  /** Short supporting context, e.g. "of 12 allocated" or "3 need attention". */
  hint?: React.ReactNode;
  tone?: KpiTone;
  href?: string;
  onClick?: () => void;
  className?: string;
  /** Staggers the entrance so a row of tiles settles in sequence. */
  index?: number;
}) {
  const interactive = Boolean(href || onClick);
  const delay = { animationDelay: `${Math.min(index, 6) * 40}ms` };

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <span
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-xl transition-transform duration-200 group-hover/kpi:scale-105",
            TONES[tone],
          )}
        >
          <Icon className="size-5" aria-hidden />
        </span>
      </div>
      <p className="mt-3 text-kpi font-semibold tabular">{value}</p>
      {hint ? <p className="mt-1 text-sm text-muted-foreground">{hint}</p> : null}
    </>
  );

  const shell = cn(
    "group/kpi rounded-xl border bg-card p-5 text-left transition-[box-shadow,border-color,transform] duration-200",
    interactive &&
      "hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md focus-visible:-translate-y-0.5 focus-visible:border-primary/40 focus-visible:shadow-md",
    className,
  );

  if (href) {
    return (
      <Link href={href} className={cn(shell, "animate-of-rise block")} style={delay}>
        {body}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cn(shell, "animate-of-rise")} style={delay}>
        {body}
      </button>
    );
  }

  return (
    <div className={cn(shell, "animate-of-rise")} style={delay}>
      {body}
    </div>
  );
}
