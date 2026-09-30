import Link from "next/link";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/shared/utils";

export type Crumb = { label: string; href?: string };

/**
 * One page header for the whole app: breadcrumb, title, description and the
 * page's actions. Every route used to hand-roll this, which is why titles and
 * padding drifted apart between screens.
 *
 * The title is a real `h1` so each route keeps exactly one top-level heading.
 */
export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
  className,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  breadcrumb?: Crumb[];
  actions?: React.ReactNode;
  className?: string;
  /** Rendered under the header, e.g. a filter bar or a tab strip. */
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-4", className)}>
      {breadcrumb?.length ? (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            {breadcrumb.map((crumb, index) => (
              <li key={crumb.label} className="flex items-center gap-1">
                {index > 0 ? (
                  <ChevronRight className="size-3.5 text-muted-foreground/60" aria-hidden />
                ) : null}
                {crumb.href ? (
                  <Link
                    href={crumb.href}
                    className="rounded transition-colors hover:text-foreground"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current="page" className="text-foreground">
                    {crumb.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-page-title font-semibold">{title}</h1>
          {description ? (
            <p className="mt-1.5 max-w-2xl text-body text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>

      {children}
    </div>
  );
}

/** Heading for a block of content inside a page, sized between title and card. */
export function SectionHeading({
  title,
  description,
  actions,
  icon: Icon,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-section-title font-semibold">
          {Icon ? <Icon className="size-5 text-muted-foreground" aria-hidden /> : null}
          {title}
        </h2>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
