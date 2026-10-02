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
  | "query"
  | "admin"
  | "users"
  | "hierarchy"
  | "activity"
  | "shield"
  | "settings";

/**
 * Navigation groups, in the order they appear. A group with no visible items is
 * dropped entirely, so a plain employee never sees an empty "HR" heading.
 */
export type NavGroup = "workspace" | "management" | "hr" | "admin" | "super";

export const NAV_GROUP_LABEL: Record<NavGroup, string> = {
  workspace: "Workspace",
  management: "Management",
  hr: "HR",
  admin: "Administration",
  super: "Super Administration",
};

export type NavItem = {
  href: string;
  label: string;
  icon: NavIcon;
  /** Roles allowed to see and open the item. */
  roles: AppRole[];
  group: NavGroup;
};

const ALL: AppRole[] = ["employee", "manager", "hr", "admin", "super_admin"];
const LEADERSHIP: AppRole[] = ["manager", "hr", "admin", "super_admin"];
const HR_ONLY: AppRole[] = ["hr", "admin", "super_admin"];
const ADMIN_ONLY: AppRole[] = ["admin", "super_admin"];
const SUPER_ONLY: AppRole[] = ["super_admin"];

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
  { href: "/hr-dashboard", label: "HR Dashboard", icon: "hr", roles: HR_ONLY, group: "hr" },
  {
    // The query surface is HR-only in the route, in `/api/ai/hr-query` and again
    // inside every `q_*` database function.
    href: "/smart-hr-query",
    label: "Smart HR Query",
    icon: "query",
    roles: HR_ONLY,
    group: "hr",
  },

  // ---- administration -------------------------------------------------------
  // Admin-only. Every one of these routes repeats the role check server-side and
  // the matching `admin_*` RPC repeats it again in the database, so reaching the
  // URL by hand gains nothing.
  { href: "/admin", label: "Admin Console", icon: "admin", roles: ADMIN_ONLY, group: "admin" },
  { href: "/admin/users", label: "Users & Roles", icon: "users", roles: ADMIN_ONLY, group: "admin" },
  {
    href: "/admin/departments",
    label: "Departments",
    icon: "directory",
    roles: ADMIN_ONLY,
    group: "admin",
  },
  {
    href: "/admin/approval-hierarchy",
    label: "Approval Hierarchy",
    icon: "hierarchy",
    roles: ADMIN_ONLY,
    group: "admin",
  },
  {
    href: "/admin/activity",
    label: "Activity & Audit",
    icon: "activity",
    roles: ADMIN_ONLY,
    group: "admin",
  },

  // ---- super administration --------------------------------------------------
  // Super-Admin-only. `admin_role_assignable` in the database is what actually
  // stops an Admin minting a peer, so these links are presentation rather than
  // the control.
  {
    href: "/super-admin",
    label: "Super Admin Console",
    icon: "shield",
    roles: SUPER_ONLY,
    group: "super",
  },
  {
    href: "/super-admin/access",
    label: "Access & Escalation",
    icon: "users",
    roles: SUPER_ONLY,
    group: "super",
  },

  // ---- account ---------------------------------------------------------------
  { href: "/settings", label: "Profile", icon: "settings", roles: ALL, group: "workspace" },
];

export function navForRole(role: AppRole): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
}

/** Items bucketed by group, with empty groups removed. */
export function groupedNavForRole(role: AppRole): { group: NavGroup; items: NavItem[] }[] {
  const items = navForRole(role);
  const groups: NavGroup[] = ["workspace", "management", "hr", "admin", "super"];
  return groups
    .map((group) => ({ group, items: items.filter((item) => item.group === group) }))
    .filter((entry) => entry.items.length > 0);
}

/**
 * Authority ladder, mirrored from `public.role_rank` in the database.
 *
 * Used for presentation only — to pick a landing page and to decide which
 * dashboard a link may point at. Authorisation itself is repeated in the route
 * handler and again in RLS, so a mismatch here can never grant access.
 */
export const ROLE_RANK: Record<AppRole, number> = {
  employee: 1,
  manager: 2,
  hr: 3,
  admin: 4,
  super_admin: 5,
};

export function hasAtLeast(role: AppRole, minimum: AppRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** Where a role lands after signing in. */
export function homeForRole(role: AppRole): string {
  switch (role) {
    case "super_admin":
      return "/super-admin";
    case "admin":
      return "/admin";
    case "hr":
      return "/hr-dashboard";
    case "manager":
    case "employee":
    default:
      return "/dashboard";
  }
}

/**
 * Whether `role` is allowed to land on `path`.
 *
 * Post-login redirects honour a `?next=` parameter, so without this an employee
 * could be bounced at an administrator URL. The page itself would refuse them
 * anyway — this exists so the user is not sent somewhere they cannot go.
 *
 * It is a routing nicety, not a security boundary: every admin route repeats the
 * check server-side and the database repeats it again in RLS.
 */
export function canRoleVisit(role: AppRole, path: string): boolean {
  const landing = homeForRole(role);

  // The landing page and anything under it is always fine.
  if (path === landing || path.startsWith(`${landing}/`)) return true;

  // Match the longest matching item so `/admin/users` is judged by its own entry
  // rather than the bare `/admin` console entry.
  const match = NAV_ITEMS.filter((item) => path === item.href || path.startsWith(`${item.href}/`)).sort(
    (a, b) => b.href.length - a.href.length,
  )[0];

  // Unknown paths fall back to the role's own home rather than being trusted.
  if (!match) return false;

  return match.roles.includes(role);
}
