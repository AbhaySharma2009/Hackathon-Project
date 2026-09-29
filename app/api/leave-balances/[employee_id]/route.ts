import { NextResponse, type NextRequest } from "next/server";
import { ApiError, toErrorResponse } from "@/server/api/errors";
import { requireSession } from "@/server/api/session";
import { z } from "zod";

const yearSchema = z.coerce.number().int().min(2000).max(2100);

type Context = { params: Promise<{ employee_id: string }> };

/**
 * GET /api/leave-balances/[employee_id]?year=
 *
 * Visible for yourself, your direct reports, and HR. The ledger has no write
 * policy at all — balances only move through the approval RPCs.
 */
export async function GET(request: NextRequest, context: Context) {
  try {
    const { employee_id } = await context.params;
    if (!z.string().uuid().safeParse(employee_id).success) {
      throw new ApiError("VALIDATION", "Invalid employee id.");
    }

    const { supabase, employee } = await requireSession();

    const rawYear = request.nextUrl.searchParams.get("year");
    const year = rawYear
      ? yearSchema.parse(rawYear)
      : new Date().getFullYear();

    if (employee_id !== employee.id) {
      const { data: allowed } = await supabase.rpc("can_manage", {
        p_employee_id: employee_id,
      });
      if (!allowed) {
        throw new ApiError("FORBIDDEN", "You can only view balances for yourself or your team.");
      }
    }

    const { data, error } = await supabase
      .from("leave_balances")
      .select("id, leave_type, year, allocated, used, remaining")
      .eq("employee_id", employee_id)
      .eq("year", year)
      .order("leave_type");

    if (error) throw error;

    return NextResponse.json({ data: data ?? [], meta: { year, employee_id } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
