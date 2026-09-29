"use client";

/**
 * Recharts wrappers for the HR dashboard.
 *
 * Split out from the dashboard client so the chart markup stays readable, and
 * so every figure is passed in already computed — these components never fetch,
 * aggregate or recalculate anything. Colours are literal class strings because
 * Tailwind cannot see dynamically built names.
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
import type { DepartmentHeadcount, DepartmentWorkforce, LeaveBalanceBucket } from "@/lib/types";

/** Leave types excluding `unpaid`, which carries no allocation to chart. */
const BALANCE_TYPES = ["casual", "sick", "annual"] as const;

const LEAVE_FILL: Record<string, string> = {
  casual: "var(--color-chart-1)",
  sick: "var(--color-chart-2)",
  annual: "var(--color-chart-3)",
  unpaid: "var(--color-chart-4)",
};

const DEPARTMENT_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

/** Recharts wants a height on the wrapper; every chart here is fixed-height. */
function ChartFrame({ children, height = 280 }: { children: React.ReactElement; height?: number }) {
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

const axisProps = {
  stroke: "var(--color-muted-foreground)",
  fontSize: 12,
  tickLine: false,
  axisLine: false,
} as const;

/** Headcount per department. */
export function HeadcountByDepartmentChart({ data }: { data: DepartmentHeadcount[] }) {
  return (
    <ChartFrame>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
        <XAxis dataKey="department" {...axisProps} interval={0} angle={-12} textAnchor="end" height={54} />
        <YAxis {...axisProps} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: "var(--color-muted)" }}
          contentStyle={{
            background: "var(--color-popover)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            fontSize: 12,
          }}
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
    <ChartFrame>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
        <XAxis dataKey="department" {...axisProps} interval={0} angle={-12} textAnchor="end" height={54} />
        <YAxis {...axisProps} />
        <Tooltip
          cursor={{ fill: "var(--color-muted)" }}
          contentStyle={{
            background: "var(--color-popover)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {BALANCE_TYPES.map((type) => (
          <Bar
            key={type}
            dataKey={`used_${type}`}
            name={type}
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
      remaining: Number(row?.remaining ?? 0),
      used: Number(row?.used ?? 0),
    };
  });

  return (
    <ChartFrame>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
        <XAxis dataKey="leave_type" {...axisProps} />
        <YAxis {...axisProps} />
        <Tooltip
          cursor={{ fill: "var(--color-muted)" }}
          contentStyle={{
            background: "var(--color-popover)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="used" name="Used" stackId="balance" fill={LEAVE_FILL.annual} maxBarSize={64} />
        <Bar
          dataKey="remaining"
          name="Remaining"
          stackId="balance"
          fill={LEAVE_FILL.casual}
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

  return (
    <ChartFrame height={240}>
      <PieChart>
        <Pie data={rows} dataKey="value" nameKey="name" innerRadius={52} outerRadius={88} paddingAngle={2}>
          {rows.map((entry, index) => (
            <Cell key={entry.name} fill={DEPARTMENT_COLORS[index % DEPARTMENT_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            background: "var(--color-popover)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ChartFrame>
  );
}
