/**
 * Hand-written mirror of supabase/migrations/0001_schema.sql.
 * Kept in sync by hand for Phase 0; regenerate with `supabase gen types` later.
 */

import type { ErrorCode } from "@/shared/errors";

export type LeaveType = "casual" | "sick" | "annual" | "unpaid";
/**
 * `approval_blocked` is Phase 3.5: the request is real and visible, but no
 * approval chain could be resolved for it, so it is parked with a reason instead
 * of being auto-approved. Only HR can move it.
 */
export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled" | "approval_blocked";
export type AppRole = "employee" | "manager" | "hr" | "admin" | "super_admin";

/** Which signature a step represents. Distinct from `app_role`. */
export type ApprovalStepRole = "manager" | "department_head" | "hr";
export type ApprovalStepStatus = "pending" | "approved" | "rejected" | "skipped";

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
  /** Phase 16: self-editable contact details. */
  phone?: string | null;
  personal_email?: string | null;
  address?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
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
  /** Phase 3.5: the level whose signature is outstanding, 1-based. */
  current_approval_level: number | null;
  /** Why a request is parked as `approval_blocked`, in the employee's words. */
  blocked_reason: string | null;
  created_at: string;
};

/** One signature in a request's frozen approval chain. */
export type ApprovalStep = {
  id: string;
  level: number;
  approver_employee_id: string;
  approver_name: string;
  approver_role: ApprovalStepRole;
  status: ApprovalStepStatus;
  comment: string | null;
  decided_at: string | null;
  created_at: string;
  /** True for the level the request is actually waiting on. */
  is_current: boolean;
};

/** GET /api/leave-requests/:id/approval-chain */
export type ApprovalChain = {
  request_id: string;
  status: LeaveStatus;
  blocked_reason: string | null;
  current_approval_level: number | null;
  /** 1, 2 or 3, from the working-day count. */
  required_levels: number;
  days: number;
  steps: ApprovalStep[];
  /** Derived by the database, never by the client. */
  viewer_can_decide: boolean;
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
  /** Phase 3.5: true when the request exists but no chain could be built. */
  approval_blocked?: boolean;
  /** Set only when `approval_blocked`, explaining what is missing. */
  approval_blocked_reason?: string | null;
  /** The first level actually awaiting a signature. */
  current_approval_level?: number | null;
};

/** Shape returned by approve_leave_request / reject_leave_request. */
export type LeaveDecision = {
  ok: boolean;
  error_code: ErrorCode | null;
  error_message: string | null;
  details?: Record<string, unknown>;
  request?: LeaveRequest & { available_balance?: number | null };
  /**
   * Phase 3.5: false when this signature only advanced the chain, so the
   * balance has NOT been spent yet. True on the final approval.
   */
  final_approval?: boolean;
  /** The level the request moved to, when it is still in progress. */
  awaiting_level?: number | null;
};

/** A raw row of `leave_approval_steps`, as the server reads it. */
export type LeaveApprovalStep = {
  id: string;
  leave_request_id: string;
  level: number;
  approver_employee_id: string;
  approver_role: ApprovalStepRole;
  status: ApprovalStepStatus;
  comment: string | null;
  decided_at: string | null;
  created_at: string;
};

/**
 * A request as it appears on the requester's own list: the row plus the frozen
 * chain, so the page can show both the current stage and the full history without
 * a request per row.
 */
export type MyLeaveRequest = LeaveRequest & { approval_chain: ApprovalStep[] };

/** Shape returned by `admin_activity_log`: live totals plus the AI audit tail. */
export type AdminActivityLog = {
  ok: boolean;
  totals: {
    by_role: Record<string, number>;
    open_alerts: number;
    auth_accounts: number;
    approvals_open: number;
    employees_total: number;
    employees_active: number;
    requests_pending: number;
    requests_blocked: number;
  };
  ai_audit: {
    id: string;
    created_at: string;
    tool_name: string;
    success: boolean;
    error: string | null;
    duration_ms: number | null;
    arguments: Record<string, unknown> | null;
  }[];
};

/** The singleton row in `approval_policy`. */
export type ApprovalPolicy = {
  id: boolean;
  short_leave_max_days: number;
  medium_leave_max_days: number;
  require_hr_over_seven: boolean;
};

/** The approver list `required_approval_levels` derives from a day's duration. */
export type RequiredApprovalLevels = {
  needs_manager: boolean;
  needs_department_head: boolean;
  needs_hr: boolean;
  level_count: number;
};

/** A person as listed in the admin console. */
export type AdminUser = {
  id: string;
  email: string;
  name: string;
  photo: string | null;
  app_role: AppRole;
  department: string | null;
  manager_id: string | null;
  role: string | null;
  join_date: string;
  is_active: boolean;
};

/** A request joined with the directory fields the inbox needs to render a row. */
export type ApprovalRequest = LeaveRequest & {
  employee_name: string;
  employee_photo: string | null;
  employee_role: string;
  employee_department: string;
  /** Phase 3.5: the chain, so the inbox can render a timeline per row. */
  approval_chain: ApprovalStep[];
  /** The level waiting on the viewer, or null when it is not their turn. */
  viewer_level: number | null;
  /** True only for the request the viewer is the assigned approver of right now. */
  viewer_can_decide: boolean;
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
  | "team_absent"
  // Phase 3.5 — a step waiting on somebody, and the handover to the next one.
  | "approval_pending"
  | "approval_escalated"
  | "approval_overdue";

// ---------------------------------------------------------------------------
// Smart HR Query (Phase 8)
//
// Mirrors of the seven `q_*` functions. Rule 5: the model picks one of these by
// name and fills in its arguments — it never produces a row shape, and the
// `summary` below is written in code from the rows, never by the model.
// ---------------------------------------------------------------------------

/** One column header in the results table. `align: "right"` for figures. */
export type HrQueryColumn = {
  key: string;
  label: string;
  align?: "left" | "right";
};

/** A result cell. Dates and names arrive as text; figures may be numeric. */
export type HrQueryRow = Record<string, string | number | boolean | null>;

/** The whole response body for POST /api/ai/hr-query. */
export type HrQueryResult = {
  type: "hr_query_result";
  /** Written by the server from `rows` alone. */
  summary: string;
  columns: HrQueryColumn[];
  rows: HrQueryRow[];
  /** The function that produced this, for the "show query details" toggle. */
  tool_used: string;
  /** The validated arguments, after the server recomputed the range. */
  params: Record<string, unknown>;
};

/** Sent when the question maps to no function in the catalog. */
export type HrQueryUnsupported = {
  type: "hr_query_unsupported";
  message: string;
  /** Offered back so the user is never left without a next step. */
  examples: string[];
};

export type OnLeaveBetweenRow = {
  employee: string;
  employee_id: string;
  department: string;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  days: number;
};

export type CountOnLeaveRow = {
  on_leave_date: string;
  department: string;
  headcount: number;
  names: string[];
};

export type LeaveUsageRow = {
  department: string;
  headcount: number;
  people_away: number;
  requests: number;
  leave_days: number;
  days_per_person: number;
};

export type LowBalanceRow = {
  employee: string;
  employee_id: string;
  department: string;
  leave_type: LeaveType;
  allocated: number;
  used: number;
  remaining: number;
};

export type PendingApprovalsRow = {
  department: string;
  pending_count: number;
  oldest_days: number;
  names: string[];
};

export type DepartmentAvailabilityRow = {
  department: string;
  headcount: number;
  avg_availability_pct: number;
  lowest_availability_pct: number;
  lowest_date: string | null;
};

export type TopLeaveTakersRow = {
  employee: string;
  employee_id: string;
  department: string;
  requests: number;
  leave_days: number;
};

export type Alert = {
  id: string;
  scope_employee_id: string | null;
  type: string;
  severity: string;
  message: string;
  related_date: string | null;
  /** Phase 3.5: the stable identity of this alert, so it is created once. */
  dedupe_key: string | null;
  related_request_id: string | null;
  created_at: string;
  is_read: boolean;
};

/**
 * One row per HR Copilot tool invocation. Written by the server through the
 * service-role client; a browser session may only read its own trail.
 */
export type AiAuditLog = {
  id: string;
  employee_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  success: boolean;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
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
      leave_approval_steps: Table<LeaveApprovalStep>;
      alerts: Table<Alert>;
      ai_audit_log: Table<AiAuditLog>;
      /** Phase 14: the authoritative department list. */
      departments: Table<{ name: string }>;
      /** Phase 14: the singleton row holding the approval thresholds. */
      approval_policy: Table<ApprovalPolicy>;
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
      required_approval_levels: {
        Args: { p_days: number };
        Returns: RequiredApprovalLevels;
      };
      // Phase 14 admin RPCs. Executed as `service_role` after the route handler
      // has checked the caller's role, so they are absent from the anon surface.
      admin_list_employees: {
        Args: { p_actor: string };
        Returns: AdminUser[];
      };
      admin_role_catalog: {
        Args: { p_actor: string };
        Returns: {
          can_assign_super_admin: boolean;
          roles: { value: AppRole; rank: number; assignable: boolean; active_count: number }[];
          fallback_approver_id: string | null;
        };
      };
      admin_create_employee: {
        Args: {
          p_actor: string;
          p_employee_id: string;
          p_email: string;
          p_full_name: string;
          p_app_role: AppRole;
          p_department: string | null;
          p_manager_id: string | null;
          p_job_title: string;
        };
        Returns: { ok: boolean; id: string; email: string };
      };
      admin_update_employee: {
        Args: {
          p_actor: string;
          p_employee_id: string;
          p_app_role: AppRole | null;
          p_department: string | null;
          p_manager_id: string | null;
          p_job_title: string | null;
        };
        Returns: { ok: boolean; id: string };
      };
      /** Phase 16 — self-service. Only these six columns can be written. */
      update_my_profile: {
        Args: {
          p_name?: string | null;
          p_phone?: string | null;
          p_personal_email?: string | null;
          p_address?: string | null;
          p_emergency_contact_name?: string | null;
          p_emergency_contact_phone?: string | null;
        };
        Returns: {
          ok: boolean;
          employee: {
            id: string;
            name: string;
            email: string;
            photo: string | null;
            phone: string | null;
            personal_email: string | null;
            address: string | null;
            emergency_contact_name: string | null;
            emergency_contact_phone: string | null;
          };
          before: { name: string };
        };
      };
      /** Phase 16 — avatar URL lives on the row; the file lives in Storage. */
      update_employee_photo: {
        Args: { p_actor: string; p_employee_id: string; p_photo: string | null };
        Returns: { ok: boolean; employee_id: string; photo: string | null };
      };
      /** Phase 16 — HR / Admin / Super Admin editing someone else's profile. */
      admin_update_employee_profile: {
        Args: {
          p_actor: string;
          p_employee_id: string;
          p_name?: string | null;
          p_email?: string | null;
          p_phone?: string | null;
          p_personal_email?: string | null;
          p_address?: string | null;
          p_emergency_contact_name?: string | null;
          p_emergency_contact_phone?: string | null;
          p_photo?: string | null;
          p_app_role?: AppRole | null;
          p_department?: string | null;
          p_manager_id?: string | null;
          p_job_title?: string | null;
          p_join_date?: string | null;
        };
        Returns: { ok: boolean; employee_id: string; app_role: AppRole };
      };
      admin_set_employee_active: {
        Args: { p_actor: string; p_employee_id: string; p_is_active: boolean };
        Returns: { ok: boolean; id: string };
      };
      admin_activity_log: {
        Args: { p_actor: string; p_limit: number };
        Returns: AdminActivityLog;
      };
      cancel_leave_request: {
        Args: { p_request_id: string };
        Returns: { ok: boolean; id: string; status: string };
      };
      can_cancel_leave_request: {
        Args: { p_request_id: string };
        Returns: boolean;
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
      /** Phase 3.5: service-role only — nudges approvers of stale steps. */
      generate_approval_alerts: {
        Args: { p_threshold_days?: number };
        Returns: number;
      };
      // -- Smart HR Query (Phase 8) ---------------------------------------
      // All seven are SECURITY DEFINER and assert the HR role inside the
      // database, so calling them with a non-HR session raises 42501.
      q_on_leave_between: {
        Args: { p_from: string; p_to: string; p_department?: string | null };
        Returns: OnLeaveBetweenRow[];
      };
      q_count_on_leave: {
        Args: { p_date: string; p_department?: string | null };
        Returns: CountOnLeaveRow[];
      };
      q_leave_usage_by_department: {
        Args: { p_from: string; p_to: string };
        Returns: LeaveUsageRow[];
      };
      q_employees_low_balance: {
        Args: { p_threshold: number; p_leave_type?: LeaveType | null };
        Returns: LowBalanceRow[];
      };
      q_pending_approvals_count: {
        Args: { p_department?: string | null };
        Returns: PendingApprovalsRow[];
      };
      q_department_availability: {
        Args: { p_from: string; p_to: string };
        Returns: DepartmentAvailabilityRow[];
      };
      q_top_leave_takers: {
        Args: { p_from: string; p_to: string; p_limit?: number | null };
        Returns: TopLeaveTakersRow[];
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
      // -- Hierarchical approval (Phase 3.5) ---------------------------------
      can_decide_leave_step: {
        Args: { p_request_id: string; p_level?: number | null };
        Returns: boolean;
      };
      required_approval_levels_unused_marker: { Args: { p_days: number }; Returns: number };
      get_approval_chain: {
        Args: { p_request_id: string };
        Returns: { ok: boolean; chain: ApprovalChain } | { ok: false; error_code: string; error_message: string };
      };
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
      approval_step_status: ApprovalStepStatus;
      approval_step_role: ApprovalStepRole;
    };
    CompositeTypes: Record<string, never>;
  };
};
