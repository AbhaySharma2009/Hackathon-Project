import type { AppRole } from "@/lib/types";

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
  | "hr";

export type NavItem = {
  href: string;
  label: string;
  icon: NavIcon;
  /** Roles allowed to see and open the item. */
  roles: AppRole[];
};

const ALL: AppRole[] = ["employee", "manager", "hr"];
const LEADERSHIP: AppRole[] = ["manager", "hr"];

/**
 * Sidebar definition. Every item is filtered by `app_role` on the server before
 * it is rendered, so the client never decides what a role may see.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard", roles: ALL },
  { href: "/directory", label: "Directory", icon: "directory", roles: ALL },
  { href: "/my-leaves", label: "My Leaves", icon: "leaves", roles: ALL },
  { href: "/calendar", label: "Calendar", icon: "calendar", roles: ALL },
  { href: "/org-chart", label: "Org Chart", icon: "org", roles: ALL },
  { href: "/approvals", label: "Approvals", icon: "approvals", roles: LEADERSHIP },
  {
    href: "/team-availability",
    label: "Team Availability",
    icon: "availability",
    roles: LEADERSHIP,
  },
  // Managers reach the same dashboard, but the API scopes it to their own team.
  { href: "/hr-dashboard", label: "HR Dashboard", icon: "hr", roles: LEADERSHIP },
];

export function navForRole(role: AppRole): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
}
