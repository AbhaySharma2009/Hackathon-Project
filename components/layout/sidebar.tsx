"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarDays,
  CalendarRange,
  ClipboardCheck,
  LayoutDashboard,
  Network,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/shared/utils";
import type { NavIcon, NavItem } from "@/shared/nav";

/** Resolves the server-supplied icon name to a real component on the client. */
const ICONS: Record<NavIcon, LucideIcon> = {
  dashboard: LayoutDashboard,
  directory: Users,
  leaves: CalendarDays,
  calendar: CalendarRange,
  org: Network,
  approvals: ClipboardCheck,
  availability: CalendarRange,
  hr: LayoutDashboard,
};

/**
 * Items are produced on the server from the session's app_role, so hiding a link
 * here is presentation only — RLS and the server role checks are the enforcement.
 */
export function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <aside className="hidden w-64 shrink-0 border-r bg-card md:flex md:flex-col">
      <div className="flex h-16 items-center gap-2 border-b px-5">
        <span className="grid size-8 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
          OF
        </span>
        <div className="leading-tight">
          <p className="text-sm font-semibold">OrgFlow</p>
          <p className="text-xs text-muted-foreground">Workforce intelligence</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 p-3" aria-label="Main">
        {items.map((item) => {
          const Icon = ICONS[item.icon];
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
