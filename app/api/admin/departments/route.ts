import type { NextRequest } from "next/server";
import { toErrorResponse, ApiError } from "@/server/api/errors";
import { parseJson, readJson } from "@/server/api/parse";
import { requireAdmin } from "@/server/api/session";
import { departmentSchema } from "@/server/admin";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/departments
 *
 * Everyone signed in may read the list — the employee directory needs it to label
 * a department — so this does not gate on the admin role.
 */
export async function GET() {
  try {
    const { supabase } = await requireAdmin();

    const { data, error } = await supabase
      .from("departments")
      .select("name")
      .order("name");

    if (error) throw error;
    return Response.json({ data: (data ?? []).map((d) => d.name) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * POST /api/admin/departments
 *
 * Written through the caller's own session, so the `departments_write` policy —
 * admin only — is what actually authorises this, not a service-role bypass.
 */
export async function POST(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const { name } = parseJson(departmentSchema, await readJson(request));

    const { data, error } = await supabase
      .from("departments")
      .insert({ name })
      .select("name")
      .single();

    if (error) throw error;
    return Response.json({ data: data.name }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** DELETE /api/admin/departments?name=Engineering */
export async function DELETE(request: NextRequest) {
  try {
    const { supabase } = await requireAdmin();
    const name = request.nextUrl.searchParams.get("name")?.trim();
    if (!name) throw new ApiError("VALIDATION", "A department name is required.");

    // Refuse while anyone is still filed under it, rather than leaving employees
    // pointing at a department that no longer exists.
    const { count, error: countError } = await supabase
      .from("employees")
      .select("id", { count: "exact", head: true })
      .eq("department", name);

    if (countError) throw countError;
    if ((count ?? 0) > 0) {
      throw new ApiError(
        "VALIDATION",
        `${count} ${(count ?? 0) === 1 ? "person is" : "people are"} still in ${name}. Move them first.`,
      );
    }

    const { error } = await supabase.from("departments").delete().eq("name", name);
    if (error) throw error;

    return Response.json({ data: { name } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
