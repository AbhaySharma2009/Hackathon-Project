import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/utils";

/**
 * Empty and error states.
 *
 * Both existed inline across pages as bare grey paragraphs ("Nothing here",
 * "Something went wrong"). These give every list a way forward: an icon, a
 * specific sentence about what is missing, and an action when one exists.
 */

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center",
        className,
      )}
    >
      <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-6" aria-hidden />
      </span>
      <div className="max-w-md space-y-1">
        <p className="text-card-title font-semibold">{title}</p>
        {description ? (
          <p className="text-body text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/**
 * The error state is told apart from the empty state on purpose: an empty list
 * is a normal outcome, a failed load is not, and the user is given the actual
 * reason plus a retry.
 */
export function ErrorState({
  title = "We couldn't load this",
  message,
  onRetry,
  retrying,
  className,
}: {
  title?: string;
  message?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-12 text-center",
        className,
      )}
    >
      <span className="grid size-12 place-items-center rounded-full bg-destructive/10 text-destructive">
        <AlertCircle className="size-6" aria-hidden />
      </span>
      <div className="max-w-md space-y-1">
        <p className="text-card-title font-semibold">{title}</p>
        <p className="text-body text-muted-foreground">
          {message || "Something went wrong while loading. Please try again."}
        </p>
      </div>
      {onRetry ? (
        <Button variant="outline" onClick={onRetry} disabled={retrying}>
          <RefreshCw className={cn("size-4", retrying && "animate-spin")} aria-hidden />
          {retrying ? "Retrying…" : "Try again"}
        </Button>
      ) : null}
    </div>
  );
}

/** Compact inline form of the same idea, for a section that failed inside a page. */
export function InlineError({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive",
        className,
      )}
    >
      <AlertCircle className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry ? (
        <Button variant="ghost" size="sm" onClick={onRetry} className="text-destructive">
          <RefreshCw className="size-4" aria-hidden />
          Retry
        </Button>
      ) : null}
    </div>
  );
}
