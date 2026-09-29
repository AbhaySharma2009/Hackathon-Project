import { NextResponse } from "next/server";
import { toErrorResponse } from "@/server/api/errors";
import { requireSession } from "@/server/api/session";

/**
 * GET /api/meta/filters
 *
 * Distinct values for the directory filter dropdowns. Managers are derived from
 * the `manager_id` column rather than `app_role`, because a session cannot read
 * that column — so this returns exactly the people who manage someone.
 */
export async function GET() {
  try {
    const { supabase } = await requireSession();

    const { data, error } = await supabase
      .from("employees")
      .select("id, name, department, role, manager_id");

    if (error) throw error;

    const employees = data ?? [];
    const departments = [...new Set(employees.map((e) => e.department))].sort();
    const roles = [...new Set(employees.map((e) => e.role))].sort();

    const byId = new Map(employees.map((e) => [e.id, e]));
    const managers = [
      ...new Set(
        employees
          .map((e) => e.manager_id)
          .filter((id): id is string => !!id)
          .map((id) => byId.get(id))
          .filter((m): m is NonNullable<typeof m> => !!m),
      ),
    ].sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({
      data: {
        departments,
        roles,
        managers: managers.map((m) => ({ id: m.id, name: m.name })),
        counts: { total: employees.length },
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
