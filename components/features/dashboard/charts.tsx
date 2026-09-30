"use client";

/**
 * Recharts wrappers for the HR dashboard.
 *
 * Split out from the dashboard client so the chart markup stays readable, and
 * so every figure is passed in already computed — these components never fetch,
 * aggregate or recalculate anything. Colours are literal strings because Tailwind
 * cannot see dynamically built names.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LEAVE_TYPE_LABEL } from "@/server/leave";
import type { DepartmentHeadcount, DepartmentWorkforce, LeaveBalanceBucket } from "@/shared/types";

/** Leave types excluding `unpaid`, which carries no allocation to chart. */
const BALANCE_TYPES = ["casual", "sick", "annual"] as const;

/**
 * One leave-type palette for the whole app, shared with the calendar so the same
 * colour means the same thing on every screen.
 */
export const LEAVE_FILL: Record<string, string> = {
  casual: "var(--color-chart-1)",
  annual: "var(--color-chart-2)",
  sick: "var(--color-chart-4)",
  unpaid: "var(--color-muted-foreground)",
};

const DEPARTMENT_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

/** Recharts wants a height on the wrapper; every chart here is fixed-height. */
function ChartFrame({
  children,
  height = 300,
  label,
}: {
  children: React.ReactElement;
  height?: number;
  /** Announced in place of the drawing, which screen readers cannot read. */
  label: string;
}) {
  return (
    <div style={{ width: "100%", height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

const axisProps = {
  stroke: "var(--color-muted-foreground)",
  fontSize: 12.5,
  tickLine: false,
  axisLine: false,
} as const;

const tooltipStyle = {
  background: "var(--color-popover)",
  border: "1px solid var(--color-border)",
  borderRadius: 10,
  boxShadow: "0 8px 24px -8px rgb(0 0 0 / 0.18)",
  fontSize: 13,
  padding: "8px 12px",
} as const;

const legendStyle = { fontSize: 13, paddingTop: 8 } as const;

/** Headcount per department. */
export function HeadcountByDepartmentChart({ data }: { data: DepartmentHeadcount[] }) {
  return (
    <ChartFrame
      label={`Headcount by department: ${data
        .map((row) => `${row.department} ${row.headcount}`)
        .join(", ")}`}
    >
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
        <XAxis dataKey="department" {...axisProps} interval={0} angle={-12} textAnchor="end" height={56} />
        <YAxis {...axisProps} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: "var(--color-muted)" }}
          contentStyle={tooltipStyle}
          labelStyle={{ fontWeight: 600, marginBottom: 4 }}
        />
        <Bar dataKey="headcount" name="Headcount" radius={[6, 6, 0, 0]} maxBarSize={56}>
          {data.map((entry, index) => (
            <Cell key={entry.department} fill={DEPARTMENT_COLORS[index % DEPARTMENT_COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ChartFrame>
  );
}

/**
 * Days used per department, stacked by leave type. `unpaid` is dropped: it has no
 * allocation, so it would only add an empty series to the stack.
 */
export function LeaveUsageByDepartmentChart({
  data,
}: {
  data: LeaveBalanceBucket[];
}) {
  // The payload is one row per (department, leave_type) pair; the chart wants one
  // row per department with a column per type, so it is pivoted here.
  const departments = [...new Set(data.map((b) => b.bucket))].sort();
  const rows = departments.map((department) => {
    const row: Record<string, string | number> = { department };
    for (const type of BALANCE_TYPES) {
      row[`used_${type}`] = Number(
        data.find((b) => b.bucket === department && b.leave_type === type)?.used ?? 0,
      );
    }
    return row;
  });

  return (
    <ChartFrame
      label={`Leave days used by department, stacked by type. ${departments
        .map((department) => {
          const parts = BALANCE_TYPES.map((type) => {
            const used = Number(
              data.find((b) => b.bucket === department && b.leave_type === type)?.used ?? 0,
            );
            return `${LEAVE_TYPE_LABEL[type]} ${used}`;
          });
          return `${department}: ${parts.join(", ")}`;
        })
        .join("; ")}`}
    >
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
        <XAxis dataKey="department" {...axisProps} interval={0} angle={-12} textAnchor="end" height={56} />
        <YAxis {...axisProps} />
        <Tooltip
          cursor={{ fill: "var(--color-muted)" }}
          contentStyle={tooltipStyle}
          labelStyle={{ fontWeight: 600, marginBottom: 4 }}
        />
        <Legend wrapperStyle={legendStyle} iconType="circle" iconSize={8} />
        {BALANCE_TYPES.map((type) => (
          <Bar
            key={type}
            dataKey={`used_${type}`}
            name={LEAVE_TYPE_LABEL[type]}
            stackId="usage"
            fill={LEAVE_FILL[type]}
            radius={type === "annual" ? [6, 6, 0, 0] : 0}
            maxBarSize={56}
          />
        ))}
      </BarChart>
    </ChartFrame>
  );
}

/** Remaining vs used days per leave type, across the whole scope. */
export function LeaveBalanceChart({ data }: { data: LeaveBalanceBucket[] }) {
  const rows = BALANCE_TYPES.map((type) => {
    const row = data.find((b) => b.leave_type === type);
    return {
      leave_type: type,
      label: LEAVE_TYPE_LABEL[type],
      remaining: Number(row?.remaining ?? 0),
      used: Number(row?.used ?? 0),
    };
  });

  return (
    <ChartFrame
      label={`Leave balance by type. ${rows
        .map((row) => `${row.label}: ${row.used} used, ${row.remaining} remaining`)
        .join("; ")}`}
    >
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
        {/* The axis is labelled from the data, not the raw enum key, so the
            chart never shows the word "casual" where "Casual" belongs. */}
        <XAxis dataKey="label" {...axisProps} />
        <YAxis {...axisProps} />
        <Tooltip
          cursor={{ fill: "var(--color-muted)" }}
          contentStyle={tooltipStyle}
          labelStyle={{ fontWeight: 600, marginBottom: 4 }}
        />
        <Legend wrapperStyle={legendStyle} iconType="circle" iconSize={8} />
        <Bar dataKey="used" name="Used" stackId="balance" fill="var(--color-chart-2)" maxBarSize={64} />
        <Bar
          dataKey="remaining"
          name="Remaining"
          stackId="balance"
          fill="var(--color-chart-1)"
          radius={[6, 6, 0, 0]}
          maxBarSize={64}
        />
      </BarChart>
    </ChartFrame>
  );
}

/** Share of the scope currently on leave, per department. */
export function AvailabilityDonut({ data }: { data: DepartmentWorkforce[] }) {
  const rows = data
    .filter((d) => d.on_leave_today > 0)
    .map((d) => ({ name: d.department, value: d.on_leave_today }));

  if (rows.length === 0) return null;

  const total = rows.reduce((sum, row) => sum + row.value, 0);

  return (
    <ChartFrame
      height={260}
      label={`People on leave today by department: ${rows
        .map((row) => `${row.name} ${row.value}`)
        .join(", ")}`}
    >
      <PieChart>
        <Pie data={rows} dataKey="value" nameKey="name" innerRadius="52%" outerRadius="82%" paddingAngle={2}>
          {rows.map((entry, index) => (
            <Cell key={entry.name} fill={DEPARTMENT_COLORS[index % DEPARTMENT_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(value, name) => [`${value} of ${total} away`, String(name)]}
        />
        <Legend wrapperStyle={legendStyle} iconType="circle" iconSize={8} />
      </PieChart>
    </ChartFrame>
  );
}
