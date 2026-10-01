"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { signOut } from "@/app/actions/auth";
import type { NavGroup, NavItem } from "@/shared/nav";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { OrgFlowMark, OrgFlowWordmark } from "@/components/layout/brand";
import { NavLinks } from "@/components/layout/nav-links";

import type { AppRole } from "@/shared/types";

/** The subset of the session the shell needs. Plain data, so it crosses the
 *  server/client boundary without pulling `server-only` code with it. */
export type SidebarUser = {
  name: string;
  role: string;
  department: string;
  app_role: AppRole;
  photo: string | null;
};

const ROLE_LABEL: Record<SidebarUser["app_role"], string> = {
  employee: "Employee",
  manager: "Manager",
  hr: "HR",
  admin: "Admin",
  super_admin: "Super Admin",
};

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

/** Profile block pinned to the bottom of the nav, with the sign-out action. */
function SidebarFooter({ user }: { user: SidebarUser }) {
  return (
    <div className="border-t p-3">
      <div className="flex items-center gap-3 rounded-lg px-2 py-2">
        <Avatar size="lg">
          {user.photo ? (
            <AvatarImage src={user.photo} alt="" />
          ) : (
            <AvatarFallback>{initials(user.name)}</AvatarFallback>
          )}
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{user.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {ROLE_LABEL[user.app_role]} · {user.department}
          </p>
        </div>
      </div>
      <form action={signOut} className="mt-1">
        <Button
          type="submit"
          variant="ghost"
          className="w-full justify-start gap-2.5 text-muted-foreground"
        >
          <LogOut className="size-4" aria-hidden />
          Sign out
        </Button>
      </form>
    </div>
  );
}

function SidebarBody({
  groups,
  user,
  onNavigate,
}: {
  groups: { group: NavGroup; items: NavItem[] }[];
  user: SidebarUser;
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className="flex h-16 shrink-0 items-center gap-2.5 border-b px-5">
        <OrgFlowMark />
        <OrgFlowWordmark />
      </div>
      <NavLinks groups={groups} onNavigate={onNavigate} />
      <SidebarFooter user={user} />
    </>
  );
}

/**
 * The application navigation.
 *
 * On desktop it is a fixed sidebar. Below `md` it collapses into a drawer opened
 * from the topbar — previously the sidebar was simply `hidden` on small screens,
 * which left a signed-in user on a phone with no way to reach any other page.
 */
export function Sidebar({
  groups,
  user,
}: {
  groups: { group: NavGroup; items: NavItem[] }[];
  user: SidebarUser;
}) {
  return (
    <>
      <aside className="sticky top-0 hidden h-screen w-68 shrink-0 flex-col border-r bg-sidebar md:flex">
        <SidebarBody groups={groups} user={user} />
      </aside>
    </>
  );
}

/**
 * The mobile menu button. Lives in the sidebar module so the trigger and the
 * drawer it controls cannot drift apart, and is placed inside the topbar by the
 * shell on small screens.
 */
export function MobileNav({
  groups,
  user,
}: {
  groups: { group: NavGroup; items: NavItem[] }[];
  user: SidebarUser;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button variant="outline" size="icon" className="md:hidden" aria-label="Open navigation" />
        }
      >
        <MenuIcon />
      </SheetTrigger>
      <SheetContent side="left" showCloseButton={false} className="w-[17.5rem] max-w-[85vw] gap-0 p-0">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SidebarBody groups={groups} user={user} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

function MenuIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="size-5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}
