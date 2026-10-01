import { NextResponse, type NextRequest } from "next/server";
import { ApiError, toErrorResponse } from "@/server/api/errors";
import { requireHrOrAdmin, requireSession } from "@/server/api/session";
import {
  DIRECTORY_COLUMNS,
  employeeCreateSchema,
  parseBody,
  parseListQuery,
  queryEmployees,
  withManagerNames,
} from "@/server/employees";

/** A missing or malformed body is a validation problem, not a 500. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError("VALIDATION", "A JSON body is required.");
  }
}

/** GET /api/employees?search=&department=&role=&manager_id=&page=&page_size= */
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    const query = parseListQuery(request.nextUrl.searchParams);

    const { rows, total } = await queryEmployees(session, query);
    const data = await withManagerNames(session, rows);

    return NextResponse.json({
      data,
      meta: {
        page: query.page,
        page_size: query.page_size,
        total,
        total_pages: Math.max(1, Math.ceil(total / query.page_size)),
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** POST /api/employees — HR only. RLS rejects anyone else even if called directly. */
export async function POST(request: NextRequest) {
  try {
    const session = await requireHrOrAdmin();
    const body = parseBody(employeeCreateSchema, await readJson(request));

    // A brand new employee has no id yet, so the cycle walk only has to check
    // that the manager is a real, active employee.
    const { data: manager } = await session.supabase
      .from("employees")
      .select("id, is_active")
      .eq("id", body.manager_id ?? "")
      .maybeSingle();

    if (body.manager_id && (!manager || !manager.is_active)) {
      throw new ApiError("VALIDATION", "The selected manager does not exist.", {
        field: "manager_id",
      });
    }

    // RETURNING is limited to the granted directory columns — `email` is not
    // readable by a session, so it cannot be used to look the row back up.
    const { data: created, error: readBackError } = await session.supabase
      .from("employees")
      .insert({
        name: body.name,
        email: body.email,
        role: body.role,
        department: body.department,
        manager_id: body.manager_id ?? null,
        join_date: body.join_date,
        photo: body.photo || null,
        app_role: "employee",
        is_active: true,
      })
      .select(DIRECTORY_COLUMNS)
      .single();

    if (readBackError || !created) {
      // 23505 = unique_violation, which in practice is always employees.email.
      if (readBackError?.code === "23505") {
        throw new ApiError("VALIDATION", "That email address is already in use.", {
          field: "email",
        });
      }
      throw new ApiError(
        "VALIDATION",
        readBackError?.message ?? "Employee was not created.",
      );
    }

    const { data: detail } = await session.supabase.rpc("get_employee_detail", {
      p_employee_id: created.id,
    });

    return NextResponse.json({ data: detail ?? created }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
