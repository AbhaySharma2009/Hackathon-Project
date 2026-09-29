import { z } from "zod";
import type { LeaveType } from "@/shared/types";

/**
 * Shared leave vocabulary. This module is isomorphic on purpose: the request
 * dialog and the history tables import the labels and the schema, so it must
 * stay free of `server-only` and `next/server` imports.
 */
export const LEAVE_TYPES = ["casual", "sick", "annual", "unpaid"] as const;
export const LEAVE_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;

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

export const LEAVE_TYPE_LABEL: Record<LeaveType, string> = {
  casual: "Casual",
  sick: "Sick",
  annual: "Annual",
  unpaid: "Unpaid",
};
