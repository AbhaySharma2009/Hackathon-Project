import { cn } from "@/shared/utils";

/**
 * The OrgFlow mark, used in the app shell and on the login page.
 *
 * It is an inline SVG rather than an image file so it stays crisp at any size
 * and inherits the brand colour, with no extra network request on first paint.
 */
export function OrgFlowMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm",
        className,
      )}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden>
        <path
          d="M5 18V9m7 9V5m7 13v-6"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <circle cx="5" cy="6" r="2" fill="currentColor" opacity="0.55" />
        <circle cx="12" cy="5" r="2" fill="currentColor" />
        <circle cx="19" cy="9.5" r="2" fill="currentColor" opacity="0.55" />
      </svg>
    </span>
  );
}

export function OrgFlowWordmark({
  className,
  tagline = "Workforce intelligence",
}: {
  className?: string;
  tagline?: string | null;
}) {
  return (
    <span className={cn("flex flex-col leading-tight", className)}>
      <span className="text-nav font-semibold tracking-tight">OrgFlow</span>
      {tagline ? (
        <span className="text-xs text-muted-foreground">{tagline}</span>
      ) : null}
    </span>
  );
}
