import "server-only";

/**
 * The Smart HR Query catalog.
 *
 * Rule 5 is enforced structurally, exactly as it is for the employee copilot:
 *
 *   1. The model chooses a *function name* from the list below and fills in typed
 *      parameters. There is no tool that accepts a query, a filter expression, or
 *      a fragment of SQL, so "run DROP TABLE employees" has nowhere to land — the
 *      nearest thing it can do is name a function that does not exist, which is
 *      rejected before any database call.
 *   2. Each handler is a fixed call to one `q_*` RPC. Those are SECURITY DEFINER
 *      and re-check the HR role inside the database, so even a direct PostgREST
 *      call with a forged parameter is refused with 42501.
 *   3. Arguments are parsed with zod before the handler runs, and every date range
 *      is re-validated here against today's date. The model resolves "next week"
 *      using the date in the system prompt; the server then checks the result is
 *      a real, bounded range rather than trusting it.
 *
 * The `summary` is written in this file, in code, from the rows that came back.
 * That is the whole point of the feature — a number the user reads is a number
 * the database produced. Letting the model write the sentence would put invented
 * figures back into the answer, which is the failure mode this design exists to
 * prevent.
 */
import { z } from "zod";
import { LEAVE_TYPES } from "@/server/leave";
import type { ToolContext } from "@/server/ai/tools.employee";
import type {
  HrQueryColumn,
  HrQueryRow,
  OnLeaveBetweenRow,
  CountOnLeaveRow,
  LeaveUsageRow,
  LowBalanceRow,
  PendingApprovalsRow,
  DepartmentAvailabilityRow,
  TopLeaveTakersRow,
} from "@/shared/types";

// ---------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------

/** A single report may not span more than a year. "Show me everything" is not a question. */
const MAX_RANGE_DAYS = 366;
/** Nothing may be dated more than two years out; beyond that it is a model slip. */
const MAX_FUTURE_DAYS = 730;
/**
 * How far back a question may reach. HR asks about the past constantly — "who
 * took the most leave last quarter", "how much did we use in Q1" — so history is
 * allowed. The bound exists to catch a nonsense year, not to forbid reporting.
 */
const MAX_PAST_DAYS = 730;
/** Matches the cap in the SQL, kept here so a too-large limit never reaches it. */
const MAX_TOP_LIMIT = 50;

/**
 * A balance threshold is a number of days. It is bounded so a model cannot ask
 * for "less than -5000 days" and receive the whole directory, which would be an
 * answer dressed as a filter.
 */
const threshold = z.coerce
  .number()
  .min(0, "A threshold of days cannot be negative.")
  .max(365, "A threshold beyond a year is not meaningful.")
  .default(3);

const department = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .nullish()
  .transform((value) => (value ? value : null));

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "That is not a real date.");

// ---------------------------------------------------------------------------
// date helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function parseUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** "1 Oct 2026", or "12–15 Oct 2026" when a range spans days within one month. */
function formatWindow(from: string, to: string): string {
  const a = parseUtc(from);
  const b = parseUtc(to);
  if (from === to) return longDate(a);
  if (a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear()) {
    return `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS[a.getUTCMonth()]} ${b.getUTCFullYear()}`;
  }
  return `${longDate(a)} to ${longDate(b)}`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function longDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Postgres returns numerics as strings; the UI wants a number where it can. */
function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Drops a trailing ".00" so 4 reads as "4" and 4.5 as "4.5". */
function days(value: unknown): string {
  const parsed = num(value);
  return Number.isInteger(parsed) ? String(parsed) : String(Math.round(parsed * 100) / 100);
}

function pct(value: unknown): string {
  return `${days(value)}%`;
}

function listOf(names: string[], limit = 4): string {
  if (names.length === 0) return "";
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`;
}

/**
 * Re-validates a model-supplied range and returns the range actually queried.
 *
 * The model turns "next week" into concrete dates using the date in the prompt.
 * That is a useful division of labour, but it is the model's arithmetic, so it is
 * checked here rather than believed: the order must be right, the span must be
 * real, and the window must be near today. This returns the clamped range so the
 * response can show HR exactly what was searched.
 */
function resolveRange(pFrom: string, pTo: string): { from: string; to: string } {
  const a = parseUtc(pFrom);
  const b = parseUtc(pTo);

  if (b.getTime() < a.getTime()) {
    throw new Error(`The range ${pFrom} to ${pTo} ends before it starts.`);
  }

  const spanDays = Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
  if (spanDays > MAX_RANGE_DAYS) {
    throw new Error(
      `A range of ${spanDays} days is too wide; ask about at most ${MAX_RANGE_DAYS} days at a time.`,
    );
  }

  const today = todayUtc();
  const latest = new Date(today.getTime() + MAX_FUTURE_DAYS * MS_PER_DAY);
  if (b.getTime() > latest.getTime()) {
    throw new Error(
      `Dates beyond ${toIso(latest)} are not available; check the year.`,
    );
  }

  // Checked in both directions. The past bound is a sanity check on the year, not
  // a restriction: last quarter is a perfectly ordinary thing for HR to ask.
  const earliest = new Date(today.getTime() - MAX_PAST_DAYS * MS_PER_DAY);
  if (a.getTime() < earliest.getTime()) {
    throw new Error(`Leave data is not available before ${toIso(earliest)}.`);
  }

  return { from: toIso(a), to: toIso(b) };
}

// ---------------------------------------------------------------------------
// tool type
// ---------------------------------------------------------------------------

export type HrToolResult = {
  columns: HrQueryColumn[];
  rows: HrQueryRow[];
  summary: string;
  /** The validated arguments, with the range the server actually used. */
  params: Record<string, unknown>;
};

type HrTool = {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  columns: HrQueryColumn[];
  handler: (context: ToolContext, args: never) => Promise<HrToolResult>;
};

function schemaOf(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. who is on leave between two dates
// ---------------------------------------------------------------------------

const onLeaveBetweenArgs = z.object({
  p_from: isoDate.describe("Inclusive start date, YYYY-MM-DD."),
  p_to: isoDate.describe("Inclusive end date, YYYY-MM-DD."),
  p_department: department.describe("Restrict to one department, or omit for the whole company."),
});

const onLeaveBetween = async (
  context: ToolContext,
  args: z.infer<typeof onLeaveBetweenArgs>,
): Promise<HrToolResult> => {
  const { from, to } = resolveRange(args.p_from, args.p_to);
  const { data, error } = await context.supabase.rpc("q_on_leave_between", {
    p_from: from,
    p_to: to,
    p_department: args.p_department,
  });
  if (error) throw error;

  const rows = (data ?? []) as OnLeaveBetweenRow[];
  const params = { from, to, department: args.p_department };

  const summary =
    rows.length === 0
      ? `Nobody is on approved leave between ${formatWindow(from, to)}${
          args.p_department ? ` in ${args.p_department}` : ""
        }.`
      : `${rows.length} ${rows.length === 1 ? "request is" : "requests are"} on approved leave between ${formatWindow(
          from,
          to,
        )}: ${listOf(
          rows.map((r) => `${r.employee} (${r.department}, ${r.leave_type})`),
        )}.`;

  return {
    columns: ON_LEAVE_COLUMNS,
    rows: rows.map((r) => ({
      employee: r.employee,
      department: r.department,
      leave_type: r.leave_type,
      start_date: r.start_date,
      end_date: r.end_date,
      days: num(r.days),
    })),
    summary,
    params,
  };
};

const ON_LEAVE_COLUMNS: HrQueryColumn[] = [
  { key: "employee", label: "Employee" },
  { key: "department", label: "Department" },
  { key: "leave_type", label: "Type" },
  { key: "start_date", label: "From" },
  { key: "end_date", label: "To" },
  { key: "days", label: "Days", align: "right" },
];

// ---------------------------------------------------------------------------
// 2. headcount away on one date
// ---------------------------------------------------------------------------

const countOnLeaveArgs = z.object({
  p_date: isoDate.describe("A single date, YYYY-MM-DD."),
  p_department: department.describe("Restrict to one department, or omit for all of them."),
});

const countOnLeave = async (
  context: ToolContext,
  args: z.infer<typeof countOnLeaveArgs>,
): Promise<HrToolResult> => {
  const { data, error } = await context.supabase.rpc("q_count_on_leave", {
    p_date: args.p_date,
    p_department: args.p_department,
  });
  if (error) throw error;

  const rows = (data ?? []) as CountOnLeaveRow[];
  const total = rows.reduce((sum, r) => sum + num(r.headcount), 0);

  const summary =
    total === 0
      ? `Nobody is on approved leave on ${longDate(parseUtc(args.p_date))}${
          args.p_department ? ` in ${args.p_department}` : ""
        }.`
      : `${total} ${total === 1 ? "person is" : "people are"} on approved leave on ${longDate(
          parseUtc(args.p_date),
        )}${args.p_department ? ` in ${args.p_department}` : ""}: ${listOf(
          rows.flatMap((r) => r.names ?? []),
        )}.`;

  return {
    columns: COUNT_ON_LEAVE_COLUMNS,
    rows: rows.map((r) => ({
      department: r.department,
      headcount: num(r.headcount),
      names: (r.names ?? []).join(", "),
    })),
    summary,
    params: { date: args.p_date, department: args.p_department },
  };
};

const COUNT_ON_LEAVE_COLUMNS: HrQueryColumn[] = [
  { key: "department", label: "Department" },
  { key: "headcount", label: "On leave", align: "right" },
  { key: "names", label: "Who" },
];

// ---------------------------------------------------------------------------
// 3. leave usage per department
// ---------------------------------------------------------------------------

const usageArgs = z.object({
  p_from: isoDate.describe("Inclusive start of the window, YYYY-MM-DD."),
  p_to: isoDate.describe("Inclusive end of the window, YYYY-MM-DD."),
});

const usageByDepartment = async (
  context: ToolContext,
  args: z.infer<typeof usageArgs>,
): Promise<HrToolResult> => {
  const { from, to } = resolveRange(args.p_from, args.p_to);
  const { data, error } = await context.supabase.rpc("q_leave_usage_by_department", {
    p_from: from,
    p_to: to,
  });
  if (error) throw error;

  const rows = (data ?? []) as LeaveUsageRow[];
  // The SQL already orders by days desc; the summary names the same row the
  // table puts first, so the sentence and the grid can never disagree.
  const top = rows[0];
  const window = formatWindow(from, to);

  const summary = !top || num(top.leave_days) === 0
    ? `No approved leave was taken between ${window}.`
    : `${top.department} has the most leave usage between ${window} with ${days(
        top.leave_days,
      )} days across ${num(top.people_away)} ${num(top.people_away) === 1 ? "person" : "people"} of ${num(
        top.headcount,
      )}.`;

  return {
    columns: USAGE_COLUMNS,
    rows: rows.map((r) => ({
      department: r.department,
      headcount: num(r.headcount),
      people_away: num(r.people_away),
      requests: num(r.requests),
      leave_days: num(r.leave_days),
      days_per_person: num(r.days_per_person),
    })),
    summary,
    params: { from, to },
  };
};

const USAGE_COLUMNS: HrQueryColumn[] = [
  { key: "department", label: "Department" },
  { key: "leave_days", label: "Leave days", align: "right" },
  { key: "people_away", label: "People", align: "right" },
  { key: "requests", label: "Requests", align: "right" },
  { key: "headcount", label: "Headcount", align: "right" },
  { key: "days_per_person", label: "Days / person", align: "right" },
];

// ---------------------------------------------------------------------------
// 4. employees running low on balance
// ---------------------------------------------------------------------------

const lowBalanceArgs = z.object({
  p_threshold: threshold.describe("Report anyone with fewer remaining days than this."),
  p_leave_type: z
    .enum(LEAVE_TYPES)
    .nullish()
    .describe("Restrict to one leave type, or omit to check all capped types."),
});

const employeesLowBalance = async (
  context: ToolContext,
  args: z.infer<typeof lowBalanceArgs>,
): Promise<HrToolResult> => {
  const { data, error } = await context.supabase.rpc("q_employees_low_balance", {
    p_threshold: args.p_threshold,
    p_leave_type: args.p_leave_type,
  });
  if (error) throw error;

  const rows = (data ?? []) as LowBalanceRow[];
  const scope = args.p_leave_type ? `${args.p_leave_type} ` : "";

  const summary =
    rows.length === 0
      ? `Everyone has at least ${days(args.p_threshold)} days of ${scope || "capped "}leave remaining this year.`
      : `${rows.length} ${rows.length === 1 ? "employee has" : "employees have"} fewer than ${days(
          args.p_threshold,
        )} days of ${scope}leave remaining: ${listOf(rows.map((r) => `${r.employee} (${days(r.remaining)}d)`))}.`;

  return {
    columns: LOW_BALANCE_COLUMNS,
    rows: rows.map((r) => ({
      employee: r.employee,
      department: r.department,
      leave_type: r.leave_type,
      allocated: num(r.allocated),
      used: num(r.used),
      remaining: num(r.remaining),
    })),
    summary,
    params: { threshold: num(args.p_threshold), leave_type: args.p_leave_type },
  };
};

const LOW_BALANCE_COLUMNS: HrQueryColumn[] = [
  { key: "employee", label: "Employee" },
  { key: "department", label: "Department" },
  { key: "leave_type", label: "Type" },
  { key: "remaining", label: "Remaining", align: "right" },
  { key: "used", label: "Used", align: "right" },
  { key: "allocated", label: "Allocated", align: "right" },
];

// ---------------------------------------------------------------------------
// 5. pending approvals
// ---------------------------------------------------------------------------

const pendingApprovalsArgs = z.object({
  p_department: department.describe("Restrict to one department, or omit for the whole company."),
});

const pendingApprovalsCount = async (
  context: ToolContext,
  args: z.infer<typeof pendingApprovalsArgs>,
): Promise<HrToolResult> => {
  const { data, error } = await context.supabase.rpc("q_pending_approvals_count", {
    p_department: args.p_department,
  });
  if (error) throw error;

  const rows = (data ?? []) as PendingApprovalsRow[];
  const total = rows.reduce((sum, r) => sum + num(r.pending_count), 0);
  const oldest = rows.reduce((max, r) => Math.max(max, num(r.oldest_days)), 0);

  const summary =
    total === 0
      ? `There are no pending leave approvals${
          args.p_department ? ` in ${args.p_department}` : ""
        }.`
      : `There ${total === 1 ? "is" : "are"} ${total} pending leave approval${
          total === 1 ? "" : "s"
        }${args.p_department ? ` in ${args.p_department}` : ""}, the oldest waiting ${oldest} ${
          oldest === 1 ? "day" : "days"
        }: ${listOf(rows.flatMap((r) => r.names ?? []))}.`;

  return {
    columns: PENDING_COLUMNS,
    rows: rows.map((r) => ({
      department: r.department,
      pending_count: num(r.pending_count),
      oldest_days: num(r.oldest_days),
      names: (r.names ?? []).join(", "),
    })),
    summary,
    params: { department: args.p_department },
  };
};

const PENDING_COLUMNS: HrQueryColumn[] = [
  { key: "department", label: "Department" },
  { key: "pending_count", label: "Pending", align: "right" },
  { key: "oldest_days", label: "Oldest (days)", align: "right" },
  { key: "names", label: "Who" },
];

// ---------------------------------------------------------------------------
// 6. department availability
// ---------------------------------------------------------------------------

const availabilityArgs = z.object({
  p_from: isoDate.describe("Inclusive start of the window, YYYY-MM-DD."),
  p_to: isoDate.describe("Inclusive end of the window, YYYY-MM-DD."),
});

const departmentAvailability = async (
  context: ToolContext,
  args: z.infer<typeof availabilityArgs>,
): Promise<HrToolResult> => {
  const { from, to } = resolveRange(args.p_from, args.p_to);
  const { data, error } = await context.supabase.rpc("q_department_availability", {
    p_from: from,
    p_to: to,
  });
  if (error) throw error;

  const rows = (data ?? []) as DepartmentAvailabilityRow[];
  // The SQL sorts worst-first, so the first row is the answer.
  const lowest = rows[0];

  const summary = !lowest
    ? `There is no availability to report between ${formatWindow(from, to)}.`
    : num(lowest.lowest_availability_pct) >= 100
    ? `Every department is fully available between ${formatWindow(
        from,
        to,
      )} — nobody on approved leave falls in this window, so ${lowest.department} (${num(
        lowest.headcount,
      )}) is at 100% and the rest match it.`
    : `${lowest.department} has the lowest availability between ${formatWindow(
        from,
        to,
      )}, dropping to ${pct(lowest.lowest_availability_pct)}${
        lowest.lowest_date ? ` on ${longDate(parseUtc(lowest.lowest_date))}` : ""
      } and averaging ${pct(lowest.avg_availability_pct)} across ${num(
        lowest.headcount,
      )} ${num(lowest.headcount) === 1 ? "person" : "people"}.`;

  return {
    columns: AVAILABILITY_COLUMNS,
    rows: rows.map((r) => ({
      department: r.department,
      headcount: num(r.headcount),
      avg_availability_pct: num(r.avg_availability_pct),
      lowest_availability_pct: num(r.lowest_availability_pct),
      lowest_date: r.lowest_date,
    })),
    summary,
    params: { from, to },
  };
};

const AVAILABILITY_COLUMNS: HrQueryColumn[] = [
  { key: "department", label: "Department" },
  { key: "avg_availability_pct", label: "Avg available", align: "right" },
  { key: "lowest_availability_pct", label: "Lowest", align: "right" },
  { key: "lowest_date", label: "On" },
  { key: "headcount", label: "Headcount", align: "right" },
];

// ---------------------------------------------------------------------------
// 7. top leave takers
// ---------------------------------------------------------------------------

const topTakersArgs = z.object({
  p_from: isoDate.describe("Inclusive start of the window, YYYY-MM-DD."),
  p_to: isoDate.describe("Inclusive end of the window, YYYY-MM-DD."),
  p_limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_TOP_LIMIT)
    .default(5)
    .describe("How many people to list, 1 to 50."),
});

const topLeaveTakers = async (
  context: ToolContext,
  args: z.infer<typeof topTakersArgs>,
): Promise<HrToolResult> => {
  const { from, to } = resolveRange(args.p_from, args.p_to);
  const limit = Math.min(Math.max(args.p_limit, 1), MAX_TOP_LIMIT);

  const { data, error } = await context.supabase.rpc("q_top_leave_takers", {
    p_from: from,
    p_to: to,
    p_limit: limit,
  });
  if (error) throw error;

  const rows = (data ?? []) as TopLeaveTakersRow[];
  const top = rows[0];

  const summary =
    !top || num(top.leave_days) === 0
      ? `No approved leave was taken between ${formatWindow(from, to)}.`
      : `${top.employee} took the most leave between ${formatWindow(from, to)} with ${days(
          top.leave_days,
        )} days, across ${num(top.requests)} ${num(top.requests) === 1 ? "request" : "requests"}.`;

  return {
    columns: TOP_TAKERS_COLUMNS,
    rows: rows.map((r) => ({
      employee: r.employee,
      department: r.department,
      requests: num(r.requests),
      leave_days: num(r.leave_days),
    })),
    summary,
    params: { from, to, limit },
  };
};

const TOP_TAKERS_COLUMNS: HrQueryColumn[] = [
  { key: "employee", label: "Employee" },
  { key: "department", label: "Department" },
  { key: "leave_days", label: "Leave days", align: "right" },
  { key: "requests", label: "Requests", align: "right" },
];

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

const REGISTRY: HrTool[] = [
  {
    name: "q_on_leave_between",
    description:
      "Who is on approved leave anywhere in a date range. Use for 'who is on leave next week'. " +
      "Give the first and last day of the range as YYYY-MM-DD. One row per request.",
    schema: onLeaveBetweenArgs,
    columns: ON_LEAVE_COLUMNS,
    handler: (context, args) => onLeaveBetween(context, args as never),
  },
  {
    name: "q_count_on_leave",
    description:
      "How many people are on approved leave on one specific date, broken down by department. " +
      "Use for 'how many are on leave on 4 October'. Distinct per person.",
    schema: countOnLeaveArgs,
    columns: COUNT_ON_LEAVE_COLUMNS,
    handler: (context, args) => countOnLeave(context, args as never),
  },
  {
    name: "q_leave_usage_by_department",
    description:
      "Total leave days taken per department over a date range, counting only working days inside the range. " +
      "Use for 'which department has the most leave usage this quarter'. Departments with no leave are included as zero.",
    schema: usageArgs,
    columns: USAGE_COLUMNS,
    handler: (context, args) => usageByDepartment(context, args as never),
  },
  {
    name: "q_employees_low_balance",
    description:
      "Active employees with fewer than a threshold of leave days remaining this year. " +
      "Use for 'show employees with less than 3 days remaining'. Optionally restrict to one leave type; " +
      "unpaid leave is excluded because it has no cap.",
    schema: lowBalanceArgs,
    columns: LOW_BALANCE_COLUMNS,
    handler: (context, args) => employeesLowBalance(context, args as never),
  },
  {
    name: "q_pending_approvals_count",
    description:
      "How many leave requests are still awaiting a decision, grouped by department, with the oldest waiting age. " +
      "Use for 'how many pending approvals are there'. Optionally restrict to one department.",
    schema: pendingApprovalsArgs,
    columns: PENDING_COLUMNS,
    handler: (context, args) => pendingApprovalsCount(context, args as never),
  },
  {
    name: "q_department_availability",
    description:
      "Per department: average availability and the worst single working day across a range. " +
      "Use for 'which department has the lowest availability next week'. Returns the worst day and the date it falls on.",
    schema: availabilityArgs,
    columns: AVAILABILITY_COLUMNS,
    handler: (context, args) => departmentAvailability(context, args as never),
  },
  {
    name: "q_top_leave_takers",
    description:
      "Employees ranked by the most leave days taken in a date range. Use for 'who took the most leave last quarter'.",
    schema: topTakersArgs,
    columns: TOP_TAKERS_COLUMNS,
    handler: (context, args) => topLeaveTakers(context, args as never),
  },
];

export function hrToolNames(): string[] {
  return REGISTRY.map((tool) => tool.name);
}

/**
 * Resolves and validates one tool call.
 *
 * An unknown name or a bad argument raises, and the caller turns that into the
 * friendly "I can't answer that yet" reply — the model gets a tool error it can
 * recover from, and a prompt asking for `DROP TABLE` lands exactly here.
 */
export function findHrTool(name: string, rawArgs: unknown) {
  const tool = REGISTRY.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(
      `Unknown tool "${name}". Available tools: ${hrToolNames().join(", ")}.`,
    );
  }

  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    throw new Error(
      `Invalid arguments for ${name}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "argument"} ${issue.message}`)
        .join("; ")}`,
    );
  }

  return { tool, args: parsed.data };
}

/**
 * The definitions handed to the model, with zod-derived JSON Schemas.
 *
 * `execute` is required by the shared `ToolDefinition` shape but is never
 * called: `runHrQuery` looks the function up by name itself, so that the call is
 * audited and the summary is built here rather than by the model. It throws
 * rather than returning a placeholder, so if that ever changes the failure is
 * loud rather than silent.
 */
export function hrToolDefinitions() {
  return REGISTRY.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: schemaOf(tool.schema),
    execute: (() => {
      throw new Error(`${tool.name} must be dispatched by name, not executed directly.`);
    }) as never,
  }));
}

export { resolveRange, formatWindow, longDate, days, pct, num, todayUtc, toIso };
export type { HrTool };
