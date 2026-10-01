import { z } from "zod";

/** Payload for creating a person. Mirrors `admin_create_employee`. */
export const createEmployeeSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  full_name: z.string().trim().min(1, "A name is required."),
  app_role: z.enum(["employee", "manager", "hr", "admin", "super_admin"]).default("employee"),
  department: z.string().trim().min(1).nullable().default(null),
  manager_id: z.string().uuid().nullable().default(null),
  job_title: z.string().trim().min(1).default("Employee"),
  /**
   * Shared with the new auth user. Supabase needs a password up front, and this
   * is a demo dataset, so it is a documented field rather than an invitation
   * email flow that cannot complete without an inbox.
   */
  password: z.string().min(8, "Password must be at least 8 characters."),
});

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

/** Every field is optional; an absent one means "leave it as it is". */
export const updateEmployeeSchema = z.object({
  app_role: z.enum(["employee", "manager", "hr", "admin", "super_admin"]).optional(),
  department: z.string().trim().min(1).optional(),
  manager_id: z.string().uuid().optional(),
  job_title: z.string().trim().min(1).optional(),
});

export const setActiveSchema = z.object({
  is_active: z.boolean(),
});

export const departmentSchema = z.object({
  name: z.string().trim().min(1, "A department name is required."),
});

export const approvalPolicySchema = z.object({
  short_leave_max_days: z.number().int().min(0).max(30),
  medium_leave_max_days: z.number().int().min(1).max(60),
  require_hr_over_seven: z.boolean(),
});