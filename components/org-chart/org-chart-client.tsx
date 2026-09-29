"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, Building2, AlertTriangle, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import Tree, { type CustomNodeElementProps, type RawNodeDatum } from "react-d3-tree";
import { apiFetch } from "@/lib/api-client";
import { createClient } from "@/lib/supabase/client";
import type { OrgNode } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmployeeDetailDrawer } from "@/components/directory/employee-detail-drawer";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Department identity on the chart. Tailwind needs these as literal class
 * strings — a lookup table is the only way to keep them statically analysable.
 */
const DEPARTMENT_STYLES: Record<string, { dot: string; text: string }> = {
  Engineering: { dot: "bg-blue-500", text: "text-blue-600 dark:text-blue-400" },
  "Product & Design": { dot: "bg-purple-500", text: "text-purple-600 dark:text-purple-400" },
  Sales: { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  "HR & Operations": { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
};

const FALLBACK_STYLE = { dot: "bg-slate-500", text: "text-slate-600 dark:text-slate-400" };

/**
 * react-d3-tree's `attributes` is `Record<string, string | number | boolean>`, so
 * a nullable photo URL cannot live there. Empty string means "no photo".
 */
type ChartNode = {
  name: string;
  attributes: {
    id: string;
    photo: string;
    role: string;
    department: string;
    reports: number;
  };
  children?: ChartNode[];
};

function toChartNode(node: OrgNode): ChartNode {
  return {
    name: node.name,
    attributes: {
      id: node.id,
      photo: node.photo ?? "",
      role: node.role,
      department: node.department,
      reports: node.direct_report_count,
    },
    children: node.children?.length ? node.children.map(toChartNode) : undefined,
  };
}

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

/** Keeps every ancestor of a match, and the match itself, so searching for
 *  "Neha" shows her reporting line rather than a floating node. */
function filterChartTree(node: ChartNode, search: string): ChartNode | null {
  const needle = search.trim().toLowerCase();
  const matches =
    needle === "" ||
    node.name.toLowerCase().includes(needle) ||
    node.attributes.role.toLowerCase().includes(needle);

  const children = (node.children ?? [])
    .map((child) => filterChartTree(child, needle))
    .filter((child): child is ChartNode => child !== null);

  // A node survives when it matches itself, or when it is on the path to a match.
  if (!matches && children.length === 0) return null;

  return { ...node, children: children.length > 0 ? children : undefined };
}

export function OrgChartClient() {
  const [forest, setForest] = useState<ChartNode[]>([]);
  const [health, setHealth] = useState<{ missing: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ zoom: 0.8, x: 400, y: 80 });

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await apiFetch<{
      data: OrgNode[];
      meta: { missing?: number };
    }>("/api/org-chart", { signal });
    setForest(response.data.map(toChartNode));
    setHealth({ missing: response.meta.missing ?? 0 });
    setError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal)
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [load]);

  // HR editing a manager in the Directory re-parents the chart live.
  useEffect(() => {
    const channel = createClient()
      .channel("org-chart-tree")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "employees" },
        () => {
          load().catch(() => {
            /* a failed background refresh keeps the current tree on screen */
          });
        },
      )
      .subscribe();

    return () => {
      void channel.unsubscribe();
    };
  }, [load]);

  const departments = useMemo(() => {
    const found = new Set<string>();
    // The tree is a few levels deep, so walk all of it rather than just the roots
    // and their children — otherwise deeper departments vanish from the legend.
    const walk = (node: ChartNode) => {
      found.add(node.attributes.department);
      for (const child of node.children ?? []) walk(child);
    };
    for (const root of forest) walk(root);
    return [...found].sort();
  }, [forest]);

  const chartData = useMemo(
    () =>
      forest
        .map((root) => filterChartTree(root, search))
        .filter((root): root is ChartNode => root !== null) as RawNodeDatum[],
    [forest, search],
  );

  // The seed has a single root, so render it directly. A second root would be
  // drawn on top of the first, so multiple roots are wrapped in a synthetic parent.
  const treeData: RawNodeDatum = useMemo(() => {
    if (chartData.length === 0) return { name: "No matching employees" };
    if (chartData.length === 1) return chartData[0];
    return { name: "OrgFlow", attributes: { id: "root" }, children: chartData };
  }, [chartData]);

  const renderNode = useCallback(
    ({ nodeDatum, toggleNode }: CustomNodeElementProps) => {
      const { id, photo, role, department: dept, reports } = nodeDatum
        .attributes as ChartNode["attributes"] & Record<string, string | number | boolean>;
      const style = DEPARTMENT_STYLES[dept] ?? FALLBACK_STYLE;
      const isSelected = selectedId === id;
      // The department control highlights rather than hides, so the reporting
      // context around a highlighted person stays on screen.
      const inDepartment = department === "all" || dept === department;

      return (
        <g
          className="cursor-pointer"
          opacity={inDepartment ? 1 : 0.25}
          onClick={(event) => {
            event.stopPropagation();
            setSelectedId(id);
          }}
        >
          {/* The clip has to be declared per node: <Tree> renders into a nested
              SVG and does not accept children, so a shared <defs> is not possible. */}
          <defs>
            <clipPath id={`avatar-${id}`}>
              <circle cx={0} cy={-32} r={20} />
            </clipPath>
          </defs>

          <rect
            x={-90}
            y={-58}
            rx={12}
            width={180}
            height={116}
            fill="var(--color-card)"
            stroke={isSelected ? "var(--color-primary)" : "var(--color-border)"}
            strokeWidth={isSelected ? 2.5 : 1}
          />
          {photo ? (
            <image
              href={photo}
              x={-20}
              y={-52}
              width={40}
              height={40}
              clipPath={`url(#avatar-${id})`}
              preserveAspectRatio="xMidYMid slice"
            />
          ) : (
            <>
              <circle cx={0} cy={-32} r={20} fill="var(--color-muted)" />
              <text
                x={0}
                y={-26}
                textAnchor="middle"
                fontSize={14}
                fontWeight={600}
                fill="var(--color-muted-foreground)"
              >
                {initials(nodeDatum.name)}
              </text>
            </>
          )}
          <text
            x={0}
            y={0}
            textAnchor="middle"
            fontSize={13}
            fontWeight={600}
            fill="var(--color-foreground)"
          >
            {nodeDatum.name.length > 20 ? `${nodeDatum.name.slice(0, 19)}…` : nodeDatum.name}
          </text>
          <text
            x={0}
            y={16}
            textAnchor="middle"
            fontSize={10}
            fill="var(--color-muted-foreground)"
          >
            {role.length > 24 ? `${role.slice(0, 23)}…` : role}
          </text>
          <circle cx={-52} cy={30} r={4} className={style.dot} />
          <text x={-44} y={34} textAnchor="start" fontSize={10} fill="var(--color-muted-foreground)">
            {dept}
          </text>
          {reports > 0 ? (
            <text
              x={52}
              y={34}
              textAnchor="end"
              fontSize={10}
              fill="var(--color-muted-foreground)"
            >
              {reports} report{reports === 1 ? "" : "s"}
            </text>
          ) : null}
          {/* Collapsing is its own control, so clicking the card can open the
              employee drawer without two actions fighting over one area. */}
          {(nodeDatum.children?.length ?? 0) > 0 ? (
            <g
              className="cursor-pointer"
              onClick={(event) => {
                event.stopPropagation();
                toggleNode();
              }}
            >
              <circle cx={72} cy={-58} r={11} fill="var(--color-muted)" />
              <text
                x={72}
                y={-54}
                textAnchor="middle"
                fontSize={13}
                fontWeight={700}
                fill="var(--color-muted-foreground)"
              >
                {nodeDatum.__rd3t.collapsed ? "+" : "–"}
              </text>
            </g>
          ) : null}
        </g>
      );
    },
    [selectedId, department],
  );

  // The tree silently drops a cyclic branch to stay finite, so the server
  // reports how many active employees could not be reached.
  const missing = health?.missing ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Org Chart</h1>
          <p className="text-sm text-muted-foreground">
            The reporting hierarchy built from <code>employees.manager_id</code>. Drag to pan, scroll to
            zoom, click a card to collapse or expand.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-56">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name or role"
              className="pl-8"
              aria-label="Search the org chart"
            />
          </div>

          <Select value={department} onValueChange={(value) => setDepartment(value ?? "all")}>
            <SelectTrigger className="w-48" aria-label="Filter by department">
              <Building2 className="size-4 text-muted-foreground" aria-hidden />
              <SelectValue placeholder="All departments" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {departments.map((name) => (
                <SelectItem key={name} value={name}>
                  <span className="flex items-center gap-2">
                    <span className={`size-2 rounded-full ${DEPARTMENT_STYLES[name]?.dot ?? FALLBACK_STYLE.dot}`} />
                    {name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="icon"
            onClick={() =>
              setViewport((v) => ({ ...v, zoom: Math.min(1.6, v.zoom + 0.15) }))
            }
            aria-label="Zoom in"
          >
            <ZoomIn className="size-4" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() =>
              setViewport((v) => ({ ...v, zoom: Math.max(0.3, v.zoom - 0.15) }))
            }
            aria-label="Zoom out"
          >
            <ZoomOut className="size-4" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setViewport({ zoom: 0.8, x: 400, y: 80 })}
            aria-label="Reset the view"
          >
            <Maximize2 className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {missing > 0 ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          {missing} {missing === 1 ? "person is" : "people are"} missing from this chart because a
          cycle in the reporting lines was truncated so the rest could render.
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex h-[640px] items-center justify-center">
              <p className="text-sm text-muted-foreground">Loading the org chart…</p>
            </div>
          ) : (
            <div className="h-[640px] w-full">
              <Tree
                data={treeData}
                orientation="vertical"
                translate={{ x: viewport.x, y: viewport.y }}
                zoom={viewport.zoom}
                onUpdate={({ zoom, translate }) => setViewport({ zoom, x: translate.x, y: translate.y })}
                renderCustomNodeElement={renderNode}
                hasInteractiveNodes
                zoomable
                draggable
                collapsible
                initialDepth={-1}
                depthFactor={160}
                nodeSize={{ x: 200, y: 140 }}
                separation={{ siblings: 1.1, nonSiblings: 1.4 }}
                pathClassFunc={() => "stroke-border"}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <span className="font-medium">Departments</span>
          {departments.map((name) => {
            const style = DEPARTMENT_STYLES[name] ?? FALLBACK_STYLE;
            return (
              <span key={name} className="flex items-center gap-1.5">
                <span className={`size-2.5 rounded-full ${style.dot}`} aria-hidden />
                <span className={style.text}>{name}</span>
              </span>
            );
          })}
        </div>

        {department !== "all" ? (
          <Badge variant="outline" className="gap-1.5">
            Highlighting {department}
          </Badge>
        ) : null}
      </div>

      {/* Clicking a card opens the same record the Directory shows, so the chart
          and the directory can never disagree about an employee. */}
      <EmployeeDetailDrawer
        key={selectedId ?? "closed"}
        employeeId={selectedId}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      />
    </div>
  );
}
