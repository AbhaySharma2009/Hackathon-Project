import "server-only";

import { z } from "zod";
import { ApiError } from "@/lib/api/errors";
import type { Session } from "@/lib/api/session";

/**
 * The columns a signed-in session is allowed to read from `employees`.
 * Kept in sync with the column GRANT in supabase/migrations/0002_rls.sql.
 * `select *` would fail: email, app_role and auth_user_id are not granted.
 */
export const DIRECTORY_COLUMNS =
  "id, name, photo, role, department, manager_id, join_date, is_active";

export type DirectoryEmployee = {
  id: string;
  name: string;
  photo: string | null;
  role: string;
  department: string;
  manager_id: string | null;
  join_date: string;
  is_active: boolean;
};

export type DirectoryEmployeeWithManager = DirectoryEmployee & {
  manager_name: string | null;
};

export const listQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  department: z.string().trim().max(80).optional(),
  role: z.string().trim().max(80).optional(),
  manager_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(12),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export function parseListQuery(params: URLSearchParams): ListQuery {
  const parsed = listQuerySchema.safeParse(Object.fromEntries(params.entries()));
  if (!parsed.success) {
    throw new ApiError("VALIDATION", "Invalid filter values.", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

/** Runs the filtered, paginated directory query. */
export async function queryEmployees(
  session: Session,
  query: ListQuery,
): Promise<{ rows: DirectoryEmployee[]; total: number }> {
  const { supabase } = session;
  let request = supabase
    .from("employees")
    .select(DIRECTORY_COLUMNS, { count: "exact" })
    .order("name", { ascending: true })
    .range((query.page - 1) * query.page_size, query.page * query.page_size - 1);

  if (query.department) request = request.eq("department", query.department);
  if (query.role) request = request.ilike("role", query.role);
  if (query.manager_id) {
    // "My team" is expressed as: reports to this person, or is this person.
    request = request.or(`manager_id.eq.${query.manager_id},id.eq.${query.manager_id}`);
  }
  if (query.search) {
    // Only the granted directory columns are searchable — email is not readable
    // by a session, so it must not appear here either.
    const term = query.search.replace(/[,%()]/g, " ").trim();
    if (term) request = request.or(`name.ilike.%${term}%,role.ilike.%${term}%,department.ilike.%${term}%`);
  }

  const { data, error, count } = await request;
  if (error) throw new ApiError("VALIDATION", error.message);

  return { rows: (data ?? []) as DirectoryEmployee[], total: count ?? 0 };
}

/** Resolves manager names for a page of employees in a single extra round trip. */
export async function withManagerNames(
  session: Session,
  rows: DirectoryEmployee[],
): Promise<DirectoryEmployeeWithManager[]> {
  const managerIds = [...new Set(rows.map((r) => r.manager_id).filter((id): id is string => !!id))];
  if (managerIds.length === 0) return rows.map((r) => ({ ...r, manager_name: null }));

  const { data } = await session.supabase
    .from("employees")
    .select("id, name")
    .in("id", managerIds);

  const names = new Map((data ?? []).map((m) => [m.id, m.name]));
  return rows.map((r) => ({ ...r, manager_name: r.manager_id ? names.get(r.manager_id) ?? null : null }));
}

// ---------------------------------------------------------------- validation

export const employeeCreateSchema = z.object({
  name: z.string().trim().min(2, "Name is required.").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  role: z.string().trim().min(2, "Designation is required.").max(120),
  department: z.string().trim().min(2, "Department is required.").max(80),
  manager_id: z.string().uuid().nullish(),
  join_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD."),
  photo: z.string().url().nullish().or(z.literal("")),
});

export const employeeUpdateSchema = employeeCreateSchema.partial();

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("VALIDATION", "Please correct the highlighted fields.", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

/**
 * Walks the reporting chain to make sure reassigning `employeeId` to
 * `managerId` would not create a loop. The `prevent_manager_cycle` trigger is
 * still the authority — this turns the database error into a friendly message
 * and catches the obvious cases before a write is attempted.
 */
export async function assertNoManagerCycle(
  session: Session,
  employeeId: string,
  managerId: string | null | undefined,
): Promise<void> {
  if (!managerId) return;
  if (managerId === employeeId) {
    throw new ApiError("VALIDATION", "An employee cannot be their own manager.", {
      field: "manager_id",
    });
  }

  const { data, error } = await session.supabase
    .from("employees")
    .select("id, manager_id, is_active")
    .eq("id", managerId)
    .maybeSingle();

  if (error) throw new ApiError("VALIDATION", error.message);
  if (!data) {
    throw new ApiError("VALIDATION", "The selected manager does not exist.", {
      field: "manager_id",
    });
  }
  if (!data.is_active) {
    throw new ApiError("VALIDATION", "An inactive employee cannot be a manager.", {
      field: "manager_id",
    });
  }

  let cursor: string | null = data.manager_id;
  let depth = 0;
  while (cursor && depth < 100) {
    if (cursor === employeeId) {
      throw new ApiError(
        "VALIDATION",
        "That change would create a reporting loop. Choose a different manager.",
        { field: "manager_id" },
      );
    }
    const { data: parent } = await session.supabase
      .from("employees")
      .select("manager_id")
      .eq("id", cursor)
      .maybeSingle();
    cursor = parent?.manager_id ?? null;
    depth += 1;
  }
}
