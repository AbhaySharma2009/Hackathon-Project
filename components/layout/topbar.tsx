"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { AlertBell } from "@/components/layout/alert-bell";
import { MobileNav, type SidebarUser } from "@/components/layout/sidebar";
import { NAV_GROUP_LABEL, type NavGroup, type NavItem } from "@/shared/nav";
import { cn } from "@/shared/utils";

const ROLE_LABEL: Record<SidebarUser["app_role"], string> = {
  employee: "Employee",
  manager: "Manager",
  hr: "HR",
  admin: "Admin",
};

/** Breadcrumb trail for the current route, derived from the same nav definition
 *  the sidebar uses, so the two can never disagree about a page's name. */
function useTrail(items: NavItem[], pathname: string) {
  const match = items.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
  if (!match) return null;
  return { group: NAV_GROUP_LABEL[match.group] as NavGroup, label: match.label, href: match.href };
}

/**
 * The sticky application header.
 *
 * It carries the breadcrumb rather than a second copy of the page title: the
 * page's own `h1` is the title, and repeating it here produced two competing
 * headings on every screen (and two `h1`s per page for assistive tech).
 */
export function Topbar({
  user,
  items,
}: {
  user: SidebarUser;
  items: NavItem[];
}) {
  const pathname = usePathname();
  const trail = useTrail(items, pathname);

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur-md md:px-6">
      <MobileNav groups={groupItems(items)} user={user} />

      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        {trail ? (
          <ol className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
            <li className="hidden sm:block">{NAV_GROUP_LABEL[trail.group]}</li>
            <li className="hidden sm:block" aria-hidden>
              <span className="text-muted-foreground/50">/</span>
            </li>
            <li className="min-w-0 truncate font-medium text-foreground" aria-current="page">
              {trail.label}
            </li>
          </ol>
        ) : (
          <Link href="/dashboard" className="text-sm font-medium">
            OrgFlow
          </Link>
        )}
      </nav>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <AlertBell appRole={user.app_role} />
        <Badge variant="secondary" className="hidden sm:inline-flex">
          {ROLE_LABEL[user.app_role]}
        </Badge>
        <span className="sr-only">
          Signed in as {user.name}, {ROLE_LABEL[user.app_role]} in {user.department}
        </span>
        <Avatar size="lg" className={cn("ring-2 ring-background")}>
          {user.photo ? (
            <AvatarImage src={user.photo} alt="" />
          ) : (
            <AvatarFallback className="bg-primary/10 text-primary">
              {user.name
                .split(" ")
                .slice(0, 2)
                .map((part) => part[0])
                .join("")
                .toUpperCase()}
            </AvatarFallback>
          )}
        </Avatar>
      </div>
    </header>
  );
}

/** Buckets the flat item list into the sidebar's groups. */
function groupItems(items: NavItem[]): { group: NavGroup; items: NavItem[] }[] {
  const order: NavGroup[] = ["workspace", "management", "hr"];
  return order
    .map((group) => ({ group, items: items.filter((item) => item.group === group) }))
    .filter((entry) => entry.items.length > 0);
}
