"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, Building2, AlertTriangle, Users, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import Tree, { type CustomNodeElementProps, type RawNodeDatum } from "react-d3-tree";
import { apiFetch } from "@/shared/api-client";
import { createClient } from "@/shared/supabase-client";
import type { OrgNode } from "@/shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmployeeDetailDrawer } from "@/components/features/directory/employee-detail-drawer";
import { PageHeader } from "@/components/design/page-header";
import { EmptyState, ErrorState } from "@/components/design/states";
import { LoadingRegion } from "@/components/design/loaders";
import { Skeleton } from "@/components/ui/skeleton";
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
  // Mirrors `viewport` so the zoom handler can compare against the last value it
  // committed without re-creating the callback on every render.
  const viewportRef = useRef(viewport);

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
      .finally(() => {
        // An aborted request has no data to show, so it must not clear `loading`
        // either. React's StrictMode runs this effect twice and aborts the first
        // run; clearing the flag anyway handed `<Tree>` an empty forest, and the
        // empty-state node is what crashed `renderNode`.
        if (!controller.signal.aborted) setLoading(false);
      });
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
    // Every node handed to react-d3-tree goes through `renderNode`, which reads
    // `attributes` unconditionally — including the empty state and the synthetic
    // root. A bare `{ name }` is therefore not a valid datum here, and it used to
    // white-screen the page whenever the chart had nothing to draw.
    const stub = (name: string): ChartNode => ({
      name,
      attributes: { id: "root", photo: "", role: "", department: "", reports: 0 },
    });

    if (chartData.length === 0) {
      return stub(search.trim() ? "No matching employees" : "No employees to show");
    }
    if (chartData.length === 1) return chartData[0];
    return { ...stub("OrgFlow"), children: chartData };
  }, [chartData, search]);

  /**
   * Applies a zoom or pan.
   *
   * `onUpdate` is not purely user-driven: react-d3-tree also fires it when the
   * `translate` / `zoom` props change. Writing a fresh object unconditionally
   * therefore made a closed loop — setState re-renders, the new props fire
   * `onUpdate` again, and React gives up at its nested-update ceiling. Committing
   * only on a real change breaks the cycle while leaving dragging and zooming
   * exactly as responsive. The epsilon keeps sub-pixel d3 rounding from being
   * read as movement.
   */
  const updateViewport = useCallback((zoom: number, x: number, y: number) => {
    const previous = viewportRef.current;
    if (
      Math.abs(zoom - previous.zoom) < 1e-4 &&
      Math.abs(x - previous.x) < 0.05 &&
      Math.abs(y - previous.y) < 0.05
    ) {
      return;
    }
    const next = { zoom, x, y };
    viewportRef.current = next;
    setViewport(next);
  }, []);

  const renderNode = useCallback(
    ({ nodeDatum, toggleNode }: CustomNodeElementProps) => {
      // Destructuring a missing `attributes` took down the whole page, so the
      // render path is total: a node the chart cannot describe still draws
      // rather than unmounting the tree.
      const { id, photo, role, department: dept, reports } = (nodeDatum.attributes ?? {
        id: "",
        photo: "",
        role: "",
        department: "",
        reports: 0,
      }) as ChartNode["attributes"] & Record<string, string | number | boolean>;
      const style = DEPARTMENT_STYLES[dept] ?? FALLBACK_STYLE;
      const isSelected = selectedId === id;
      // The department control highlights rather than hides, so the reporting
      // context around a highlighted person stays on screen.
      const inDepartment = department === "all" || dept === department;

      return (
        <g
          className="of-org-node cursor-pointer"
          tabIndex={0}
          role="button"
          aria-label={`${nodeDatum.name}, ${role}, ${dept}${reports > 0 ? `, ${reports} direct report${reports === 1 ? "" : "s"}` : ""}`}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setSelectedId(id);
            }
          }}
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
              <circle cx={0} cy={-34} r={22} />
            </clipPath>
          </defs>

          <rect
            x={-92}
            y={-60}
            rx={14}
            width={184}
            height={122}
            fill="var(--color-card)"
            stroke={isSelected ? "var(--color-primary)" : "var(--color-border)"}
            strokeWidth={isSelected ? 2.5 : 1}
          />
          {/* A soft lift behind the card, so a selected node reads as raised
              rather than merely outlined. */}
          {isSelected ? (
            <rect
              x={-92}
              y={-60}
              rx={14}
              width={184}
              height={122}
              fill="var(--color-primary)"
              opacity={0.08}
            />
          ) : null}
          {photo ? (
            <image
              href={photo}
              x={-22}
              y={-56}
              width={44}
              height={44}
              clipPath={`url(#avatar-${id})`}
              preserveAspectRatio="xMidYMid slice"
            />
          ) : (
            <>
              <circle cx={0} cy={-34} r={22} fill="var(--color-muted)" />
              <text
                x={0}
                y={-28}
                textAnchor="middle"
                fontSize={15}
                fontWeight={600}
                fill="var(--color-muted-foreground)"
              >
                {initials(nodeDatum.name)}
              </text>
            </>
          )}
          <text
            x={0}
            y={2}
            textAnchor="middle"
            fontSize={14}
            fontWeight={600}
            fill="var(--color-foreground)"
          >
            {nodeDatum.name.length > 20 ? `${nodeDatum.name.slice(0, 19)}…` : nodeDatum.name}
          </text>
          <text
            x={0}
            y={19}
            textAnchor="middle"
            fontSize={11.5}
            fill="var(--color-muted-foreground)"
          >
            {role.length > 26 ? `${role.slice(0, 25)}…` : role}
          </text>
          <circle cx={-54} cy={36} r={4} className={style.dot} />
          <text x={-46} y={40} textAnchor="start" fontSize={11.5} fill="var(--color-muted-foreground)">
            {dept}
          </text>
          {reports > 0 ? (
            <text
              x={54}
              y={40}
              textAnchor="end"
              fontSize={11.5}
              fontWeight={600}
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
              <circle cx={74} cy={-60} r={11} fill="var(--color-muted)" />
              <text
                x={74}
                y={-56}
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
      <PageHeader
        title="Org Chart"
        description="The reporting hierarchy built from employees.manager_id. Drag to pan, scroll to zoom, click a card to open the employee's record, or use the +/− control to collapse their branch."
        actions={
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
            // Routed through the same guard as the drag handler so the ref stays
            // in step with the state; a direct setViewport here would leave the
            // ref stale and the next `onUpdate` would look like a real change.
            onClick={() => {
              const v = viewportRef.current;
              updateViewport(Math.min(1.6, v.zoom + 0.15), v.x, v.y);
            }}
            aria-label="Zoom in"
          >
            <ZoomIn className="size-4" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              const v = viewportRef.current;
              updateViewport(Math.max(0.3, v.zoom - 0.15), v.x, v.y);
            }}
            aria-label="Zoom out"
          >
            <ZoomOut className="size-4" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => updateViewport(0.8, 400, 80)}
            aria-label="Reset the view"
          >
            <Maximize2 className="size-4" aria-hidden />
          </Button>
        </div>
        }
      />

      {error ? (
        <ErrorState
          title="We couldn't load the org chart"
          message={error}
          retrying={loading}
          onRetry={() => {
            setLoading(true);
            setError(null);
            void load()
              .catch((err: Error) => setError(err.message))
              .finally(() => setLoading(false));
          }}
        />
      ) : null}

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

      {!error ? (
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex h-[640px] flex-col items-center justify-center gap-4" aria-hidden>
              <LoadingRegion label="Loading the org chart" />
              <div className="flex flex-col items-center gap-3">
                <Skeleton className="size-11 rounded-full" />
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
              <div className="mt-6 grid grid-cols-3 gap-8 opacity-60">
                {[0, 1, 2].map((column) => (
                  <div key={column} className="flex flex-col items-center gap-8">
                    <Skeleton className="h-24 w-44 rounded-xl" />
                    <Skeleton className="h-20 w-40 rounded-xl" />
                  </div>
                ))}
              </div>
            </div>
          ) : forest.length === 0 ? (
            // The error, or the empty org, is already explained above. Mounting
            // the chart here would only draw a placeholder card.
            <div className="flex h-[640px] items-center justify-center px-6">
              <EmptyState
                className="border-0"
                icon={Users}
                title="There is nobody to chart yet"
                description="Once employees are added with a manager, the hierarchy appears here automatically."
              />
            </div>
          ) : (
            <div className="h-[640px] w-full">
              <Tree
                data={treeData}
                orientation="vertical"
                translate={{ x: viewport.x, y: viewport.y }}
                zoom={viewport.zoom}
                onUpdate={({ zoom, translate }) =>
                  updateViewport(zoom, translate.x, translate.y)
                }
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
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
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
        key={`drawer-${selectedId ?? "closed"}`}
        employeeId={selectedId}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      />
    </div>
  );
}
