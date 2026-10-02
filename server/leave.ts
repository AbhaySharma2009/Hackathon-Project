import { z } from "zod";
import type { LeaveType } from "@/shared/types";

/**
 * Shared leave vocabulary. This module is isomorphic on purpose: the request
 * dialog and the history tables import the labels and the schema, so it must
 * stay free of `server-only` and `next/server` imports.
 */
export const LEAVE_TYPES = ["casual", "sick", "annual", "unpaid"] as const;
// `approval_blocked` is a real status an employee can see on their own list, so it
// has to survive the `?status=` filter rather than failing validation.
export const LEAVE_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "approval_blocked",
] as const;

/** ISO calendar date, `YYYY-MM-DD`. The database parses it into a `date`. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.");

export const leaveRequestSchema = z.object({
  leave_type: z.enum(LEAVE_TYPES, { message: "Choose a leave type." }),
  start_date: isoDate,
  end_date: isoDate,
  reason: z
    .string()
    .trim()
    .min(5, "Give a short reason (at least 5 characters).")
    .max(500, "Keep the reason under 500 characters."),
});

export type LeaveRequestInput = z.infer<typeof leaveRequestSchema>;

export const leaveListSchema = z.object({
  status: z.enum(LEAVE_STATUSES).optional(),
  employee_id: z.string().uuid().optional(),
});

export type LeaveListQuery = z.infer<typeof leaveListSchema>;

/**
 * Decision bodies for the approval workflow. Approving may carry an optional
 * note; rejecting must explain itself, so the client and the RPC both require it.
 */
export const approveSchema = z.object({
  comment: z
    .string()
    .trim()
    .max(500, "Keep the comment under 500 characters.")
    .optional()
    .or(z.literal("")),
});

export const rejectSchema = z.object({
  comment: z
    .string()
    .trim()
    .min(3, "Give a reason of at least 3 characters so the employee knows what to change.")
    .max(500, "Keep the comment under 500 characters."),
});

export type ApproveInput = z.infer<typeof approveSchema>;
export type RejectInput = z.infer<typeof rejectSchema>;

/** Statuses the manager inbox groups under, in tab order. */
export const INBOX_TABS = ["pending", "approved", "rejected"] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

/**
 * `leave_approval_steps.level` is `check (level > 0)`, so this can never name a real
 * approval step. Asking the database about a level that does not exist is how the
 * approvals inbox asks a question with exactly one possible answer.
 */
export const NO_APPROVAL_STEP_LEVEL = 0;

/**
 * Can this request be decided at all?
 *
 * `can_decide_leave_step` deliberately says nothing about a request's status, so the
 * status gate lives here: a decided request is history, and offering "Approve" on one
 * only produces a VALIDATION error.
 */
export function isUndecided(status: string): boolean {
  return status === "pending" || status === "approval_blocked";
}

/**
 * The `p_level` to ask `can_decide_leave_step` with, or `undefined` when the question
 * has no answer and nobody may be offered a decision.
 *
 * The predicate is written as `... and (p_level is null or s.level = p_level)`, so a
 * null argument does NOT mean "this request's current level" — it drops the level
 * constraint altogether, and the predicate then matches any pending step the viewer
 * holds anywhere on that request's chain. Verified against a live caller session:
 * `p_level` of 1 returns true, a level with no step returns false, and null returns
 * true again for the same viewer on the same request.
 *
 * That matters because `build_approval_chain` parks an unrouteable request with
 * `current_approval_level = NULL` while still writing the department head's step as
 * `pending`. Passing that null straight through let a department head match a parked
 * request they can never sign: `approve_leave_request` answers a parked request with
 * "only HR can decide it", so the inbox would offer a button that always fails.
 *
 * A parked request is therefore asked about a level no step can have, which leaves
 * `is_hr()` as the only way to answer true. HR's authority still comes from the
 * predicate rather than being restated here. A routable request is asked about its own
 * current level, and one with no current level is not asked about at all, because
 * `approve_leave_request` returns NOT_FOUND for everybody when there is no step at the
 * level it locks.
 */
export function decisionProbeLevel(row: { status: string; current_approval_level: number | null }): number | undefined {
  if (row.status === "approval_blocked") return NO_APPROVAL_STEP_LEVEL;
  if (row.current_approval_level === null) return undefined;
  return row.current_approval_level;
}

export const LEAVE_TYPE_LABEL: Record<LeaveType, string> = {
  casual: "Casual",
  sick: "Sick",
  annual: "Annual",
  unpaid: "Unpaid",
};
