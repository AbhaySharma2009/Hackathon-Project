"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  CalendarDays,
  CalendarRange,
  ClipboardCheck,
  GitBranch,
  LayoutDashboard,
  Network,
  ScrollText,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/shared/utils";
import { NAV_GROUP_LABEL, type NavGroup, type NavIcon, type NavItem } from "@/shared/nav";

/** Resolves the server-supplied icon name to a real component on the client. */
const ICONS: Record<NavIcon, LucideIcon> = {
  dashboard: LayoutDashboard,
  directory: Users,
  leaves: CalendarDays,
  calendar: CalendarRange,
  org: Network,
  approvals: ClipboardCheck,
  availability: Users,
  alerts: Bell,
  hr: LayoutDashboard,
  query: Search,
  admin: ShieldCheck,
  users: Users,
  hierarchy: GitBranch,
  activity: ScrollText,
  shield: ShieldAlert,
  settings: Settings,
};

export function navIcon(name: NavIcon): LucideIcon {
  return ICONS[name];
}

export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The grouped navigation list. Rendered twice — once in the desktop sidebar and
 * once inside the mobile drawer — so both stay in lockstep.
 *
 * The active row is marked three ways rather than by tint alone: a background,
 * a left indicator bar, and `aria-current="page"`.
 */
export function NavLinks({
  groups,
  onNavigate,
  className,
}: {
  groups: { group: NavGroup; items: NavItem[] }[];
  /** Called after a link is chosen, so the mobile drawer can close itself. */
  onNavigate?: () => void;
  className?: string;
}) {
  const pathname = usePathname();

  // Prefetch the route when the user hovers over a link, so the page is ready
  // when they click. This avoids the "click -> wait for JS -> fetch -> render" delay.
  const handleMouseEnter = (href: string) => {
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      requestIdleCallback(() => {
        const link = document.createElement("link");
        link.rel = "prefetch";
        link.href = href;
        document.head.appendChild(link);
      });
    }
  };

  return (
    <nav className={cn("flex-1 space-y-6 overflow-y-auto px-3 py-4", className)} aria-label="Main">
      {groups.map(({ group, items }) => (
        <div key={group}>
          <p className="px-3 pb-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
            {NAV_GROUP_LABEL[group]}
          </p>
          <ul className="space-y-0.5">
            {items.map((item) => {
              const Icon = ICONS[item.icon];
              const active = isNavActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    onClick={onNavigate}
                    onMouseEnter={() => handleMouseEnter(item.href)}
                    className={cn(
                      "group/nav relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-nav font-medium transition-[color,background-color] duration-150",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                    )}
                  >
                    {active ? (
                      <span
                        aria-hidden
                        className="absolute inset-y-1.5 left-0 w-1 rounded-full bg-primary"
                      />
                    ) : null}
                    <Icon
                      className={cn(
                        "size-[1.15rem] shrink-0 transition-colors",
                        active
                          ? "text-primary"
                          : "text-muted-foreground/80 group-hover/nav:text-foreground",
                      )}
                      aria-hidden
                    />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
