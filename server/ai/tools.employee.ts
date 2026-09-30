import "server-only";

/**
 * The whitelisted tools the copilot may call.
 *
 * Rule 5 is enforced structurally here, not by prompt wording:
 *
 *   1. No tool accepts an `employee_id`. There is no argument through which the
 *      model could name somebody else, so a crafted prompt like "show me Priya's
 *      balance" has nowhere to put the request. The employee is taken from the
 *      session and nowhere else.
 *   2. Every query runs on `context.supabase`, the signed-in employee's own
 *      cookie-bound client. RLS therefore applies underneath each one, so even
 *      the tools that legitimately read colleagues' data (a manager, a team) can
 *      only read what that person is already entitled to see.
 *   3. Arguments are parsed with zod before the handler sees them, so a model
 *      that invents an argument gets a validation error, not a wider query.
 *
 * `parse_leave_request` is the one tool that produces a side effect on the
 * client — but not a write. It returns a draft plus the database's own
 * dry-run verdict; the request is only ever created by POST /api/leave-requests.
 */
import { z } from "zod";
import { LEAVE_STATUSES, LEAVE_TYPES } from "@/server/leave";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/shared/types";
import type { AppRole } from "@/shared/types";
import type { ToolDefinition } from "@/server/ai/llm";

export type ToolContext = {
  /** Cookie-bound client for the signed-in employee, so RLS applies. */
  supabase: SupabaseClient<Database>;
  employee: { id: string; app_role: AppRole; name: string; manager_id: string | null };
};

/** Directory columns are the only ones a session may read. */
const DIRECTORY = "id, name, role, department, manager_id, is_active";

/** A model asking for "everything" must not be able to page the whole table. */
const MAX_HISTORY = 25;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.");

// ---------------------------------------------------------------------------
// 1. profile
// ---------------------------------------------------------------------------

const getMyProfileArgs = z.object({});

const getMyProfile = async (context: ToolContext) => {
  const { data, error } = await context.supabase.rpc("current_employee");
  if (error) throw error;

  const row = data as Record<string, unknown> | null;
  if (!row) throw new Error("No employee record for this session.");

  return {
    name: row.name,
    job_title: row.role,
    department: row.department,
    joined_on: row.join_date,
    email: row.email,
    // `auth_user_id` is deliberately dropped: it is a credential-adjacent
    // identifier and the model has no use for it.
  };
};

// ---------------------------------------------------------------------------
// 2. balance
// ---------------------------------------------------------------------------

const getMyLeaveBalanceArgs = z.object({
  leave_type: z.enum(LEAVE_TYPES).optional(),
});

const getMyLeaveBalance = async (context: ToolContext, args: z.infer<typeof getMyLeaveBalanceArgs>) => {
  // RLS restricts this table to the caller's own rows, and the query is pinned to
  // their id as well — belt and braces, because a missing filter here would be a
  // data leak rather than a wrong answer.
  let query = context.supabase
    .from("leave_balances")
    .select("leave_type, year, allocated, used, remaining")
    .eq("employee_id", context.employee.id)
    .eq("year", new Date().getFullYear());

  if (args.leave_type) query = query.eq("leave_type", args.leave_type);

  const { data, error } = await query;
  if (error) throw error;

  return { year: new Date().getFullYear(), balances: data ?? [] };
};

// ---------------------------------------------------------------------------
// 3. history
// ---------------------------------------------------------------------------

const getMyLeaveHistoryArgs = z.object({
  status: z.enum(LEAVE_STATUSES).optional(),
  // `.catch`, not a hard reject: "show me all my leave history" is a fair
  // question, and the model answers it with `limit: 99999`. Failing the call
  // teaches it nothing and costs the user an answer, so an out-of-range limit
  // is clamped to the maximum instead. The bounds stay in the published schema
  // so the model can still see them.
  limit: z.coerce.number().int().min(1).max(MAX_HISTORY).default(10).catch(MAX_HISTORY),
});

const getMyLeaveHistory = async (context: ToolContext, args: z.infer<typeof getMyLeaveHistoryArgs>) => {
  let query = context.supabase
    .from("leave_requests")
    .select("id, leave_type, start_date, end_date, days, reason, status, manager_comment, decided_at, created_at")
    .eq("employee_id", context.employee.id)
    .order("start_date", { ascending: false })
    .limit(args.limit);

  if (args.status) query = query.eq("status", args.status);

  const { data, error } = await query;
  if (error) throw error;

  return {
    count: data?.length ?? 0,
    requests: (data ?? []).map((row) => ({
      ...row,
      days: Number(row.days),
    })),
  };
};

// ---------------------------------------------------------------------------
// 4. next approved leave
// ---------------------------------------------------------------------------

const getMyNextLeaveArgs = z.object({});

const getMyNextLeave = async (context: ToolContext) => {
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await context.supabase
    .from("leave_requests")
    .select("id, leave_type, start_date, end_date, days, status")
    .eq("employee_id", context.employee.id)
    .eq("status", "approved")
    .gte("end_date", today)
    .order("start_date", { ascending: true })
    .limit(1);
  if (error) throw error;

  const next = (data ?? [])[0] ?? null;
  return { next_leave: next ? { ...next, days: Number(next.days) } : null };
};

// ---------------------------------------------------------------------------
// 5. rejection reason
// ---------------------------------------------------------------------------

const getRejectionReasonArgs = z.object({
  // Optional on purpose: the common question is "why was my last one rejected?",
  // and requiring an id would make the model invent one.
  request_id: z.string().uuid().optional(),
});

const getRejectionReason = async (context: ToolContext, args: z.infer<typeof getRejectionReasonArgs>) => {
  let query = context.supabase
    .from("leave_requests")
    .select("id, leave_type, start_date, end_date, days, reason, manager_comment, decided_at")
    .eq("employee_id", context.employee.id)
    .eq("status", "rejected")
    .order("decided_at", { ascending: false, nullsFirst: false })
    .limit(1);

  if (args.request_id) {
    // Still pinned to the caller, so a supplied id cannot reach somebody else's
    // request — it just matches nothing.
    query = query.eq("id", args.request_id);
  }

  const { data, error } = await query;
  if (error) throw error;

  const rejected = (data ?? [])[0] ?? null;
  if (!rejected) {
    return { found: false, note: "You have no rejected leave requests." };
  }

  return {
    found: true,
    request: {
      ...rejected,
      days: Number(rejected.days),
      // `manager_comment` is why the leave was refused. If a manager rejected
      // without one, say so rather than letting the model fill the gap.
      manager_comment: rejected.manager_comment,
    },
  };
};

// ---------------------------------------------------------------------------
// 6. manager
// ---------------------------------------------------------------------------

const getMyManagerArgs = z.object({});

const getMyManager = async (context: ToolContext) => {
  if (!context.employee.manager_id) {
    return { manager: null, note: "You do not have a manager assigned." };
  }

  const { data, error } = await context.supabase
    .from("employees")
    .select(DIRECTORY)
    .eq("id", context.employee.manager_id)
    .maybeSingle();
  if (error) throw error;

  if (!data) return { manager: null, note: "Your manager's record could not be read." };

  return {
    manager: {
      name: data.name,
      job_title: data.role,
      department: data.department,
    },
  };
};

// ---------------------------------------------------------------------------
// 7. team
// ---------------------------------------------------------------------------

const getMyTeamArgs = z.object({});

const getMyTeam = async (context: ToolContext) => {
  // An employee has no reports, so "my team" is their manager's reporting line:
  // their manager, and their fellow colleagues. A manager additionally sees
  // their direct reports. Both are ordinary RLS-visible directory rows, and no
  // balance, reason or request of another person is read.
  const { data: me, error: meError } = await context.supabase
    .from("employees")
    .select("manager_id")
    .eq("id", context.employee.id)
    .maybeSingle();
  if (meError) throw meError;

  const managerId = me?.manager_id ?? null;

  if (context.employee.app_role === "manager") {
    const { data: reports, error } = await context.supabase
      .from("employees")
      .select(DIRECTORY)
      .eq("manager_id", context.employee.id)
      .eq("is_active", true)
      .order("name");
    if (error) throw error;

    return {
      relationship: "your direct reports",
      team: reports ?? [],
    };
  }

  if (!managerId) {
    return { relationship: "you have no manager, so there is no team to show", team: [] };
  }

  const { data: colleagues, error } = await context.supabase
    .from("employees")
    .select(DIRECTORY)
    .eq("manager_id", managerId)
    .eq("is_active", true)
    .order("name");
  if (error) throw error;

  return {
    relationship: "you and your colleagues, all reporting to the same manager",
    team: (colleagues ?? []).filter((person) => person.id !== context.employee.id),
  };
};

// ---------------------------------------------------------------------------
// 8. who is away
// ---------------------------------------------------------------------------

const getWhoIsOnLeaveArgs = z.object({
  date: isoDate.optional(),
});

const getWhoIsOnLeave = async (context: ToolContext, args: z.infer<typeof getWhoIsOnLeaveArgs>) => {
  const target = args.date ?? new Date().toISOString().slice(0, 10);
  // `get_calendar_leaves` is the existing role-scoped read: HR sees the
  // organisation, a manager their reports, and an employee only their own
  // teammates. It returns names and dates — never anybody's reason or balance.
  const monthStart = `${target.slice(0, 7)}-01`;

  const { data, error } = await context.supabase.rpc("get_calendar_leaves", {
    p_month_start: monthStart,
  });
  if (error) throw error;

  const away = (data ?? [])
    .filter((leave) => leave.start_date <= target && leave.end_date >= target)
    .map((leave) => ({
      name: leave.employee_name,
      department: leave.employee_department,
      leave_type: leave.leave_type,
      start_date: leave.start_date,
      end_date: leave.end_date,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    date: target,
    // Named explicitly so the model can say "your team" rather than implying
    // this is the whole company.
    scope: "people you are allowed to see",
    count: away.length,
    people: away,
  };
};

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

type AnyTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (context: ToolContext, args: never) => Promise<unknown>;
};

/**
 * A JSON Schema object built from the zod schema, so the model is told exactly
 * what the handler will accept and the two cannot drift.
 */
function schemaOf(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
}

const REGISTRY: AnyTool[] = [
  {
    name: "get_my_profile",
    description:
      "The signed-in employee's own profile: name, job title, department, join date. Takes no arguments.",
    parameters: schemaOf(getMyProfileArgs),
    handler: (context) => getMyProfile(context),
  },
  {
    name: "get_my_leave_balance",
    description:
      "The signed-in employee's leave balance for the current year, per leave type. Can be filtered to one leave_type.",
    parameters: schemaOf(getMyLeaveBalanceArgs),
    handler: (context, args) => getMyLeaveBalance(context, args as never),
  },
  {
    name: "get_my_leave_history",
    description:
      "The signed-in employee's own leave requests, newest first. Can be filtered by status and limited to at most 25 rows.",
    parameters: schemaOf(getMyLeaveHistoryArgs),
    handler: (context, args) => getMyLeaveHistory(context, args as never),
  },
  {
    name: "get_my_next_leave",
    description:
      "The signed-in employee's next approved, not-yet-started leave. Returns null when they have none.",
    parameters: schemaOf(getMyNextLeaveArgs),
    handler: (context) => getMyNextLeave(context),
  },
  {
    name: "get_rejection_reason",
    description:
      "Why the signed-in employee's leave was rejected, including the manager's comment. With no argument it returns their most recent rejection.",
    parameters: schemaOf(getRejectionReasonArgs),
    handler: (context, args) => getRejectionReason(context, args as never),
  },
  {
    name: "get_my_manager",
    description: "Who the signed-in employee's manager is. Takes no arguments.",
    parameters: schemaOf(getMyManagerArgs),
    handler: (context) => getMyManager(context),
  },
  {
    name: "get_my_team",
    description:
      "Directory listing of the signed-in employee's team: their colleagues, or their direct reports for a manager. Names, titles and departments only.",
    parameters: schemaOf(getMyTeamArgs),
    handler: (context) => getMyTeam(context),
  },
  {
    name: "get_who_is_on_leave",
    description:
      "Who is away on a given date, limited to the people the signed-in employee is allowed to see. Defaults to today.",
    parameters: schemaOf(getWhoIsOnLeaveArgs),
    handler: (context, args) => getWhoIsOnLeave(context, args as never),
  },
];

/** The tools exposed to the model, bound to one session. */
export function toolsFor(context: ToolContext): ToolDefinition[] {
  return REGISTRY.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: (args: never) => tool.handler(context, args),
  }));
}

export function toolNames(): string[] {
  return REGISTRY.map((tool) => tool.name);
}

/**
 * Runs one tool call: the name must be whitelisted, and the arguments must
 * satisfy the zod schema the model was shown. An unknown name or a bad argument
 * is an ordinary tool error the model can see and recover from — never an
 * exception that reaches the user.
 */
export function findTool(context: ToolContext, name: string, rawArgs: unknown) {
  const tool = REGISTRY.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new ToolError(
      `Unknown tool "${name}". Available tools: ${toolNames().join(", ")}.`,
    );
  }

  const schema = zodFor(name);
  const parsed = schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    throw new ToolError(
      `Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  }

  return { tool, args: parsed.data };
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

function zodFor(name: string): z.ZodTypeAny {
  switch (name) {
    case "get_my_profile":
      return getMyProfileArgs;
    case "get_my_leave_balance":
      return getMyLeaveBalanceArgs;
    case "get_my_leave_history":
      return getMyLeaveHistoryArgs;
    case "get_my_next_leave":
      return getMyNextLeaveArgs;
    case "get_rejection_reason":
      return getRejectionReasonArgs;
    case "get_my_manager":
      return getMyManagerArgs;
    case "get_my_team":
      return getMyTeamArgs;
    case "get_who_is_on_leave":
      return getWhoIsOnLeaveArgs;
    default:
      throw new ToolError(`Unknown tool "${name}".`);
  }
}
