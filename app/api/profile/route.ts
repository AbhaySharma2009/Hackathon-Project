import type { NextRequest } from "next/server";
import { ApiError, toErrorResponse } from "@/server/api/errors";
import { parseJson, readJson } from "@/server/api/parse";
import { requireSession } from "@/server/api/session";
import { z } from "zod";
import type { AppRole } from "@/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The RPCs answer in "KIND: message"; the API answers in status codes.
 *
 * `ApiError` rather than a plain `Error`, because `toErrorResponse` maps only
 * `ApiError` and turns anything else into an opaque 500 — which would report a
 * correct refusal as a server fault.
 */
function rethrow(error: { message: string }): never {
  const [kind, ...rest] = error.message.split(": ");
  const message = rest.join(": ") || error.message;

  if (kind === "FORBIDDEN") throw new ApiError("FORBIDDEN", message);
  if (kind === "VALIDATION") throw new ApiError("VALIDATION", message);
  if (kind === "NOT_FOUND") throw new ApiError("NOT_FOUND", message);
  if (kind === "UNAUTHENTICATED") throw new ApiError("FORBIDDEN", "You must be signed in.");
  throw error;
}

/**
 * GET /api/profile — the caller's own profile.
 *
 * Split into two blocks on purpose, because that split is the requirement:
 *
 *   `personal`      — the six fields a person owns and may change
 *   `organisation`  — everything HR controls, which is read-only here
 *
 * The read-only block is still returned, because the page has to display it.
 * Naming those fields explicitly is what stops the UI growing an editable input
 * for one of them by accident.
 */
export async function GET() {
  try {
    const { supabase, employee } = await requireSession();

    // `email` and `app_role` are deliberately not granted to `authenticated` —
    // column privileges on `employees` stop short of them so they cannot be read
    // straight out of the table. `get_employee_detail` is SECURITY DEFINER and
    // returns the full row minus `auth_user_id` for yourself, which is the
    // established way this codebase reads them.
    const { data: detail, error: detailError } = await supabase.rpc("get_employee_detail", {
      p_employee_id: employee.id,
    });

    if (detailError) throw detailError;
    if (!detail) throw new ApiError("NOT_FOUND", "No employee record is linked to this account.");

    const row = detail as unknown as {
      id: string;
      name: string;
      email: string;
      photo: string | null;
      phone?: string | null;
      personal_email?: string | null;
      address?: string | null;
      emergency_contact_name?: string | null;
      emergency_contact_phone?: string | null;
      app_role: AppRole;
      role: string;
      department: string;
      manager_id: string | null;
      join_date: string;
      is_active: boolean;
    };

    let managerName: string | null = null;
    if (row.manager_id) {
      const { data: manager } = await supabase
        .from("employees")
        .select("name")
        .eq("id", row.manager_id)
        .maybeSingle();
      managerName = manager?.name ?? null;
    }

    // Balances are read from the table, matching /api/leave-balances. RLS limits
    // this to the caller's own rows, so the page shows exactly the figures the
    // rest of the app shows — and this route is never a way to write them.
    const { data: balances } = await supabase
      .from("leave_balances")
      .select("leave_type, allocated, used")
      .eq("employee_id", employee.id)
      .eq("year", new Date().getFullYear())
      .order("leave_type");

    return Response.json({
      data: {
        personal: {
          name: row.name,
          photo: row.photo,
          phone: row.phone ?? null,
          personal_email: row.personal_email ?? null,
          address: row.address ?? null,
          emergency_contact_name: row.emergency_contact_name ?? null,
          emergency_contact_phone: row.emergency_contact_phone ?? null,
        },
        organisation: {
          employee_id: row.id,
          work_email: row.email,
          app_role: row.app_role,
          designation: row.role,
          department: row.department,
          manager_name: managerName,
          joining_date: row.join_date,
          account_status: row.is_active ? "active" : "inactive",
        },
        balances: (balances ?? []).map((b) => ({
          leave_type: b.leave_type,
          allocated: b.allocated,
          used: b.used,
          remaining: b.allocated - b.used,
        })),
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * PUT /api/profile — the caller edits their own personal details.
 *
 * There is no parameter here for role, department, manager, join date or
 * employee id, and `update_my_profile` has none either. Rejecting them explicitly
 * still matters: a silently dropped field reads as "saved" to whoever typed it.
 */
const updateSchema = z
  .object({
    name: z.string().trim().min(2, "Name is required.").max(120).optional(),
    phone: z.string().trim().max(32).nullish(),
    personal_email: z.string().trim().max(254).nullish(),
    address: z.string().trim().max(300).nullish(),
    emergency_contact_name: z.string().trim().max(120).nullish(),
    emergency_contact_phone: z.string().trim().max(32).nullish(),
  })
  .strict();

/** Fields the caller must never set on themselves. */
const PROTECTED = [
  "employee_id",
  "id",
  "app_role",
  "role",
  "department",
  "manager_id",
  "join_date",
  "is_active",
  "email",
  "auth_user_id",
] as const;

export async function PUT(request: NextRequest) {
  try {
    const { supabase } = await requireSession();
    const raw = await readJson(request);

    if (raw && typeof raw === "object") {
      const attempted = PROTECTED.filter((key) => key in (raw as object));
      if (attempted.length > 0) {
        throw new ApiError(
          "VALIDATION",
          `${attempted.join(", ")} ${
            attempted.length === 1 ? "is" : "are"
          } managed by HR or an administrator and cannot be changed here.`,
        );
      }
    }

    const body = parseJson(updateSchema, raw);

    // A key the caller did not send must leave the stored value alone. Passing
    // null through would clear the field, so absent keys become null here and
    // the RPC's coalesce keeps what is already stored.
    const { data, error } = await supabase.rpc("update_my_profile", {
      p_name: body.name ?? null,
      p_phone: "phone" in body ? (body.phone ?? "") : null,
      p_personal_email: "personal_email" in body ? (body.personal_email ?? "") : null,
      p_address: "address" in body ? (body.address ?? "") : null,
      p_emergency_contact_name:
        "emergency_contact_name" in body ? (body.emergency_contact_name ?? "") : null,
      p_emergency_contact_phone:
        "emergency_contact_phone" in body ? (body.emergency_contact_phone ?? "") : null,
    });

    if (error) rethrow(error);

    return Response.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
