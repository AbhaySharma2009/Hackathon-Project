/**
 * Hand-written mirror of supabase/migrations/0001_schema.sql.
 * Kept in sync by hand for Phase 0; regenerate with `supabase gen types` later.
 */

import type { ErrorCode } from "@/shared/errors";

export type LeaveType = "casual" | "sick" | "annual" | "unpaid";
export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";
export type AppRole = "employee" | "manager" | "hr";

export type Employee = {
  id: string;
  auth_user_id: string | null;
  name: string;
  email: string;
  photo: string | null;
  role: string;
  app_role: AppRole;
  department: string;
  manager_id: string | null;
  join_date: string;
  is_active: boolean;
  created_at: string;
};

export type LeaveRequest = {
  id: string;
  employee_id: string;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  days: number;
  reason: string | null;
  status: LeaveStatus;
  manager_comment: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
};

export type LeaveBalance = {
  id: string;
  employee_id: string;
  year: number;
  leave_type: LeaveType;
  allocated: number;
  used: number;
  remaining: number;
};

/** A conflicting request reported by the validation RPC. */
export type LeaveConflict = {
  id: string;
  status: LeaveStatus;
  start_date: string;
  end_date: string;
  days: number;
};

/** Shape returned by validate_leave_request / create_leave_request. */
export type LeaveValidation = {
  valid: boolean;
  days: number;
  available_balance: number | null;
  error_code: ErrorCode | null;
  error_message: string | null;
  conflicts: LeaveConflict[];
  id?: string;
};

/** Shape returned by approve_leave_request / reject_leave_request. */
export type LeaveDecision = {
  ok: boolean;
  error_code: ErrorCode | null;
  error_message: string | null;
  details?: Record<string, unknown>;
  request?: LeaveRequest & { available_balance?: number | null };
};

/** A request joined with the directory fields the inbox needs to render a row. */
export type ApprovalRequest = LeaveRequest & {
  employee_name: string;
  employee_photo: string | null;
  employee_role: string;
  employee_department: string;
};

/** Org chart node shape returned by get_org_tree. */
export type OrgNode = {
  id: string;
  name: string;
  photo: string | null;
  role: string;
  department: string;
  direct_report_count: number;
  children: OrgNode[];
  cycle?: boolean;
};

/** Approved leave with employee info for the calendar. */
export type CalendarLeave = LeaveRequest & {
  employee_name: string;
  employee_photo: string | null;
  employee_department: string;
};

// ---------------------------------------------------------------------------
// HR dashboard (Phase 5)
//
// Mirrors the payload of `get_dashboard_summary()`. Every figure is computed in
// Postgres, so these are read-only shapes — nothing here is recalculated in the
// client.
// ---------------------------------------------------------------------------

export type DepartmentHeadcount = {
  department: string;
  headcount: number;
};

export type LeaveBalanceBucket = {
  /** A department name, or "ALL" for the org-wide roll-up. */
  bucket: string;
  leave_type: LeaveType;
  allocated: number;
  used: number;
  remaining: number;
  people: number;
};

export type TopLeaveTaker = {
  employee_id: string;
  name: string;
  photo: string | null;
  department: string;
  days: number;
  requests: number;
};

/** One entry in the activity feed: a submission, or a decision on one. */
export type LeaveActivity = {
  id: string;
  event: "submitted" | "approved" | "rejected";
  employee_id: string;
  employee_name: string;
  employee_photo: string | null;
  department: string;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  days: number;
  status: LeaveStatus;
  actor_name: string;
  decided_at: string | null;
  created_at: string;
  occurred_at: string;
};

export type DepartmentWorkforce = {
  department: string;
  headcount: number;
  on_leave_today: number;
  available_today: number;
  availability_pct: number;
  pending_requests: number;
};

export type DashboardSummary = {
  scope: {
    app_role: AppRole;
    /** False for a manager, who sees only their own team. */
    org_wide: boolean;
    employee_count: number;
  };
  generated_at: string;
  quarter: { start: string; label: string };
  kpis: {
    headcount_total: number;
    on_leave_today: number;
    pending_approvals: number;
    oldest_pending_age_days: number;
    average_remaining_balance: number;
  };
  headcount_by_department: DepartmentHeadcount[];
  leave_balance_by_type: LeaveBalanceBucket[];
  leave_balance_by_department: LeaveBalanceBucket[];
  top_leave_takers: TopLeaveTaker[];
  recent_activity: LeaveActivity[];
  department_workforce: DepartmentWorkforce[];
};

// ---------------------------------------------------------------------------
// Workforce intelligence (Phase 6)
//
// Read-only mirrors of the `get_availability` / `get_leave_impact` payloads. The
// ratios, the working-day counts and the risk level are all decided in Postgres;
// the client renders them and never recomputes one.
// ---------------------------------------------------------------------------

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertType =
  | "leave_approved"
  | "leave_rejected"
  | "leave_pending"
  | "balance_low"
  | "upcoming_leave"
  | "team_absent";

export type Alert = {
  id: string;
  scope_employee_id: string | null;
  type: string;
  severity: string;
  message: string;
  related_date: string | null;
  created_at: string;
  is_read: boolean;
};

/** One day of the availability grid. Weekends are returned but flagged. */
export type AvailabilityDay = {
  /** YYYY-MM-DD. */
  date: string;
  is_weekend: boolean;
  team_size: number;
  on_leave_count: number;
  available_count: number;
  /** 0-100, one decimal. A team of nobody is reported as 100. */
  availability_pct: number;
  names_on_leave: string[];
  ids_on_leave: string[];
};

/** GET /api/availability */
export type TeamAvailability = {
  scope: {
    app_role: AppRole;
    /** False when a manager narrowed the view to their own reporting line. */
    org_wide: boolean;
    viewer_id: string;
    /** Which filter actually applied, for the page's own caption. */
    basis: "team" | "department" | "organisation";
  };
  from: string;
  to: string;
  generated_at: string;
  days: AvailabilityDay[];
  summary: {
    team_size: number;
    /** Lowest availability across the working days in range, or 100 if none. */
    worst_day: AvailabilityDay | null;
    /** Mean availability over the working days in range. */
    average_availability_pct: number;
    days_below_threshold: number;
  };
};

/** Someone in the same reporting line who is already away on those dates. */
export type ImpactOverlap = {
  employee_id: string;
  name: string;
  start_date: string;
  end_date: string;
  days: number;
};

/** GET /api/leave-requests/:id/impact */
export type LeaveImpact = {
  request_id: string;
  employee_id: string;
  employee_name: string;
  status: LeaveStatus;
  start_date: string;
  end_date: string;
  days: number;
  /** The reporting line, counting the manager themselves. */
  team_size: number;
  already_on_leave: number;
  overlapping_leave: ImpactOverlap[];
  working_days: number;
  /** Earliest working day at the lowest availability, or null if all weekend. */
  worst_date: string | null;
  worst_day_availability_pct: number | null;
  /** low >= 75%, medium >= 50%, high below that. Null when there is no working day. */
  risk: "low" | "medium" | "high" | null;
  per_day: AvailabilityDay[];
};

/** GET /api/alerts */
export type AlertsFeed = {
  alerts: Alert[];
  unread_count: number;
  generated_at: string;
};

type Table<Row> = {
  Row: Row;
  Insert: Partial<Row> & Record<string, unknown>;
  Update: Partial<Row> & Record<string, unknown>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      employees: Table<Employee>;
      leave_requests: Table<LeaveRequest>;
      leave_balances: Table<LeaveBalance>;
      alerts: Table<Alert>;
    };
    Views: Record<string, never>;
    Functions: {
      working_days: {
        Args: { start: string; end: string };
        Returns: number;
      };
      validate_leave_request: {
        Args: { p_leave_type: LeaveType; p_start: string; p_end: string };
        Returns: LeaveValidation;
      };
      create_leave_request: {
        Args: { p_leave_type: LeaveType; p_start: string; p_end: string; p_reason: string };
        Returns: LeaveValidation & { id?: string };
      };
      approve_leave_request: {
        Args: { p_request_id: string; p_comment?: string | null };
        Returns: LeaveDecision;
      };
      reject_leave_request: {
        Args: { p_request_id: string; p_comment: string };
        Returns: LeaveDecision;
      };
      get_org_tree: {
        Args: Record<string, never>;
        Returns: OrgNode[];
      };
      get_calendar_leaves: {
        Args: {
          p_month_start: string;
          p_department?: string | null;
          p_team?: string | null;
        };
        Returns: CalendarLeave[];
      };
      get_dashboard_summary: {
        Args: Record<string, never>;
        Returns: DashboardSummary;
      };
      is_working_day: { Args: { p_date: string }; Returns: boolean };
      team_size: { Args: { p_manager_id: string }; Returns: number };
      get_availability: {
        Args: {
          p_from?: string | null;
          p_to?: string | null;
          p_department?: string | null;
          p_manager_id?: string | null;
        };
        Returns: AvailabilityDay[];
      };
      get_leave_impact: {
        Args: { p_request_id: string };
        Returns: LeaveImpact;
      };
      /** Service-role only — invoked by POST /api/alerts/refresh. */
      generate_alerts: {
        Args: Record<string, never>;
        Returns: number;
      };
      org_tree_health: {
        Args: Record<string, never>;
        Returns: {
          node_count: number;
          active_count: number;
          missing: number;
          trigger_enabled: boolean;
        };
      };
      current_employee_id: { Args: Record<string, never>; Returns: string | null };
      current_app_role: { Args: Record<string, never>; Returns: AppRole | null };
      is_manager_of: { Args: { p_employee_id: string }; Returns: boolean };
      is_hr: { Args: Record<string, never>; Returns: boolean };
      can_manage: { Args: { p_employee_id: string }; Returns: boolean };
      current_employee: { Args: Record<string, never>; Returns: Employee };
      get_employee_detail: {
        Args: { p_employee_id: string };
        Returns: Record<string, unknown> | null;
      };
    };
    Enums: {
      leave_type: LeaveType;
      leave_status: LeaveStatus;
      app_role: AppRole;
    };
    CompositeTypes: Record<string, never>;
  };
};
