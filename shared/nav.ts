import type { AppRole } from "@/shared/types";

/**
 * Icons are referenced by name, not by component. The sidebar is a Client
 * Component and React cannot pass component functions across the server/client
 * boundary — the name is resolved to a lucide icon inside the client bundle.
 */
export type NavIcon =
  | "dashboard"
  | "directory"
  | "leaves"
  | "calendar"
  | "org"
  | "approvals"
  | "availability"
  | "alerts"
  | "hr"
  | "query";

/**
 * Navigation groups, in the order they appear. A group with no visible items is
 * dropped entirely, so a plain employee never sees an empty "HR" heading.
 */
export type NavGroup = "workspace" | "management" | "hr";

export const NAV_GROUP_LABEL: Record<NavGroup, string> = {
  workspace: "Workspace",
  management: "Management",
  hr: "HR",
};

export type NavItem = {
  href: string;
  label: string;
  icon: NavIcon;
  /** Roles allowed to see and open the item. */
  roles: AppRole[];
  group: NavGroup;
};

const ALL: AppRole[] = ["employee", "manager", "hr"];
const LEADERSHIP: AppRole[] = ["manager", "hr"];

/**
 * Sidebar definition. Every item is filtered by `app_role` on the server before
 * it is rendered, so the client never decides what a role may see.
 *
 * Hiding a link is presentation only. Each route repeats the check server-side
 * and the database repeats it again in RLS, so a hand-typed URL gains nothing.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard", roles: ALL, group: "workspace" },
  { href: "/my-leaves", label: "My Leaves", icon: "leaves", roles: ALL, group: "workspace" },
  { href: "/calendar", label: "Calendar", icon: "calendar", roles: ALL, group: "workspace" },
  { href: "/directory", label: "Directory", icon: "directory", roles: ALL, group: "workspace" },
  { href: "/org-chart", label: "Org Chart", icon: "org", roles: ALL, group: "workspace" },
  {
    href: "/approvals",
    label: "Approvals",
    icon: "approvals",
    roles: LEADERSHIP,
    group: "management",
  },
  {
    href: "/team-availability",
    label: "Team Availability",
    icon: "availability",
    roles: LEADERSHIP,
    group: "management",
  },
  {
    // `/api/alerts` is readable by every role, but the alert *queue* is a
    // management concern. Employees keep the notification bell in the topbar.
    href: "/alerts",
    label: "Alerts",
    icon: "alerts",
    roles: LEADERSHIP,
    group: "management",
  },
  // Managers reach the same dashboard, but the API scopes it to their own team.
  { href: "/hr-dashboard", label: "HR Dashboard", icon: "hr", roles: LEADERSHIP, group: "hr" },
  {
    // The query surface is HR-only in the route, in `/api/ai/hr-query` and again
    // inside every `q_*` database function.
    href: "/smart-hr-query",
    label: "Smart HR Query",
    icon: "query",
    roles: ["hr"],
    group: "hr",
  },
];

export function navForRole(role: AppRole): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
}

/** Items bucketed by group, with empty groups removed. */
export function groupedNavForRole(role: AppRole): { group: NavGroup; items: NavItem[] }[] {
  const items = navForRole(role);
  const groups: NavGroup[] = ["workspace", "management", "hr"];
  return groups
    .map((group) => ({ group, items: items.filter((item) => item.group === group) }))
    .filter((entry) => entry.items.length > 0);
}
