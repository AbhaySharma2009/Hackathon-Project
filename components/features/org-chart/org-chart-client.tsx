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
import {
  AVATAR_SIZE,
  CARD_WIDTH,
  CONTENT_WIDTH,
  DEPT_DOT_GAP,
  DEPT_DOT_R,
  DEPT_LEADING,
  DEPT_SIZE,
  META_SIZE,
  MAX_CARD_HEIGHT,
  NAME_LEADING,
  NAME_SIZE,
  NAME_WEIGHT,
  ROLE_LEADING,
  ROLE_SIZE,
  ROLE_WEIGHT,
  TOGGLE_R,
  TOGGLE_STRIP,
  measureCard,
} from "@/components/features/org-chart/card-layout";
import {
  DEFAULT_TRANSLATE,
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  ROOTS_KEY,
  ZOOM_STEP,
  applyCollapse,
  clampZoom,
  filterChartTree,
  fittedZoomFor,
  fitViewport,
  initials,
  toChartNode,
  type ChartNode,
} from "@/components/features/org-chart/chart-tree";
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
 * Picks the zoom the chart opens at, before it can measure itself. Read once,
 * lazily: `<Tree>` is not mounted during SSR (the first paint is the loading
 * skeleton), so the viewport never reaches server-rendered HTML and measuring
 * here cannot cause a hydration mismatch. `fitToContents` reframes the chart as
 * soon as the tree is drawn; this is only the first guess, and the fallback if
 * measuring fails.
 */
function initialZoom(): number {
  return typeof window === "undefined" ? DEFAULT_ZOOM : fittedZoomFor(window.innerWidth);
}

export function OrgChartClient() {
  const [forest, setForest] = useState<ChartNode[]>([]);
  const [health, setHealth] = useState<{ missing: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Folded branches, owned here rather than by react-d3-tree's `collapsible`:
  // its collapse walks the whole subtree but its expand only touches the node
  // that was clicked, so a reopened branch would come back with every report
  // underneath it still folded.
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [viewport, setViewport] = useState(() => ({ zoom: initialZoom(), ...DEFAULT_TRANSLATE }));
  const [defaultZoom] = useState(initialZoom);
  // Mirrors `viewport` so the zoom handler can compare against the last value it
  // committed without re-creating the callback on every render.
  const viewportRef = useRef(viewport);
  // Set once the chart has been framed to its contents, and once the viewer has
  // zoomed or panned by hand — after which the chart stops re-framing itself.
  const chartHostRef = useRef<HTMLDivElement | null>(null);
  const hasFitted = useRef(false);
  const viewerAdjusted = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    // `apiFetch` yields null when a response body is not JSON at all — a proxy
    // error page, or a body lost to an aborted read. Reading `.data` off that
    // threw "Cannot read properties of null" and took the page down, so the
    // shape is checked here and reported as a normal load failure.
    const response = await apiFetch<{ data?: OrgNode[]; meta?: { missing?: number } } | null>(
      "/api/org-chart",
      { signal },
    );
    if (!response || !Array.isArray(response.data)) {
      throw new Error("The org chart service returned an unreadable response.");
    }
    setForest(response.data.map(toChartNode));
    setHealth({ missing: response.meta?.missing ?? 0 });
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

  const chartData = useMemo(() => {
    // While a search is active the fold state is ignored, otherwise a match could
    // be hidden inside a branch the viewer had closed.
    const ignoreFold = search.trim().length > 0;
    return forest
      .map((root) => filterChartTree(root, search))
      .filter((root): root is ChartNode => root !== null)
      .map((root) => applyCollapse(root, collapsedIds, ignoreFold)) as RawNodeDatum[];
  }, [forest, search, collapsedIds]);

  // The seed has a single root, so render it directly. A second root would be
  // drawn on top of the first, so multiple roots are wrapped in a synthetic parent.
  const treeData: RawNodeDatum = useMemo(() => {
    // Every node handed to react-d3-tree goes through `renderNode`, which reads
    // `attributes` unconditionally — including the empty state and the synthetic
    // root. A bare `{ name }` is therefore not a valid datum here, and it used to
    // white-screen the page whenever the chart had nothing to draw.
    //
    // `reports` carries how many roots the wrapper holds. `renderNode` decides
    // whether to draw the +/− control from that count, so a folded wrapper keeps
    // its control and can be opened again.
    const stub = (name: string, reports = 0): ChartNode => ({
      name,
      attributes: {
        id: name === "OrgFlow" ? ROOTS_KEY : name,
        photo: "",
        role: "",
        department: "",
        reports,
        synthetic: name === "OrgFlow",
      },
    });

    if (chartData.length === 0) {
      return stub(search.trim() ? "No matching employees" : "No employees to show");
    }
    if (chartData.length === 1) return chartData[0];

    const rootsFolded = collapsedIds.has(ROOTS_KEY);
    return {
      ...stub("OrgFlow", chartData.length),
      children: rootsFolded ? undefined : chartData,
    };
  }, [chartData, search, collapsedIds]);

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

  /**
   * Frames the whole tree inside the chart's own box.
   *
   * `getBBox()` reports the extent in the chart's own coordinates, so it is
   * unaffected by the zoom already applied to the group — the same tree measures
   * the same either way, which is what makes re-fitting safe to repeat.
   */
  const fitToContents = useCallback(() => {
    const host = chartHostRef.current;
    if (!host) return false;
    const group = host.querySelector<SVGGElement>("g.rd3t-g");
    const svg = host.querySelector<SVGSVGElement>("svg.rd3t-svg");
    if (!group || !svg) return false;
    let box: DOMRect;
    try {
      box = group.getBBox();
    } catch {
      return false;
    }
    // A tree mid-render measures 0x0, and fitting that would jump the view.
    if (!box.width || !box.height) return false;
    const container = { width: svg.clientWidth, height: svg.clientHeight };
    if (!container.width || !container.height) return false;
    const fit = fitViewport(
      { x: box.x, y: box.y, width: box.width, height: box.height },
      container,
    );
    updateViewport(fit.zoom, fit.x, fit.y);
    return true;
  }, [updateViewport]);

  // Frame the tree once it has something in it, and again if the chart is resized
  // while the viewer has not taken control of the zoom themselves.
  useEffect(() => {
    if (loading || !forest.length) return;
    const frame = requestAnimationFrame(() => {
      if (!viewerAdjusted.current) hasFitted.current = fitToContents();
    });
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
    function onResize() {
      if (!viewerAdjusted.current && hasFitted.current) fitToContents();
    }
  }, [loading, forest, fitToContents]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const renderNode = useCallback(
    ({ nodeDatum }: CustomNodeElementProps) => {
      // Destructuring a missing `attributes` took down the whole page, so the
      // render path is total: a node the chart cannot describe still draws
      // rather than unmounting the tree.
      const { id, photo, role, department: dept, reports, synthetic } = (nodeDatum.attributes ?? {
        id: "",
        photo: "",
        role: "",
        department: "",
        reports: 0,
      }) as ChartNode["attributes"] & Record<string, string | number | boolean>;
      const style = DEPARTMENT_STYLES[dept] ?? FALLBACK_STYLE;
      const isSelected = !synthetic && selectedId === id;
      // The department control highlights rather than hides, so the reporting
      // context around a highlighted person stays on screen.
      const inDepartment = department === "all" || dept === department;
      // A folded branch is rendered without its `children`, so their presence cannot
      // answer this. The direct-report count from the server can, and it is what keeps
      // the reopen control on the card once the branch has been folded away.
      const hasChildren = reports > 0 || (nodeDatum.children?.length ?? 0) > 0;
      const isCollapsed = collapsedIds.has(id);
      const card = measureCard(nodeDatum.name, role, dept, reports);

      // The toggle straddles the bottom border rather than sitting in a corner,
      // so it reads as the branch control and is separated from every text row
      // by the reserved strip the layout adds for it.
      const cardHeight = card.height + (hasChildren ? TOGGLE_STRIP : 0);
      const cardTop = -cardHeight / 2;
      const toggleY = cardTop + card.height + TOGGLE_STRIP / 2;
      const halfWidth = CARD_WIDTH / 2;
      const halfContent = CONTENT_WIDTH / 2;
      const deptTextX = -halfContent + DEPT_DOT_GAP;

      return (
        <g
          className={synthetic ? "of-org-node" : "of-org-node cursor-pointer"}
          tabIndex={synthetic ? -1 : 0}
          role={synthetic ? "group" : "button"}
          aria-label={
            synthetic
              ? `${reports} top-level ${reports === 1 ? "employee" : "employees"}`
              : `${nodeDatum.name}, ${role}, ${dept}${reports > 0 ? `, ${reports} direct report${reports === 1 ? "" : "s"}` : ""}`
          }
          onKeyDown={(event) => {
            // The wrapper stands for no employee, so there is no record to open.
            if (synthetic) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setSelectedId(id);
            }
          }}
          opacity={inDepartment ? 1 : 0.25}
          onClick={(event) => {
            event.stopPropagation();
            if (!synthetic) setSelectedId(id);
          }}
        >
          {/* The clip has to be declared per node: <Tree> renders into a nested
              SVG and does not accept children, so a shared <defs> is not possible. */}
          <defs>
            <clipPath id={`avatar-${id}`}>
              <circle cx={0} cy={card.avatarCenterY} r={AVATAR_SIZE / 2} />
            </clipPath>
          </defs>

          <rect
            className="of-org-node__card"
            x={-halfWidth}
            y={cardTop}
            rx={16}
            width={CARD_WIDTH}
            height={cardHeight}
            fill="var(--color-card)"
            stroke={isSelected ? "var(--color-primary)" : "var(--color-border)"}
            strokeWidth={isSelected ? 2.5 : 1}
          />
          {/* A soft lift behind the card, so a selected node reads as raised
              rather than merely outlined. */}
          {isSelected ? (
            <rect
              className="of-org-node__lift"
              x={-halfWidth}
              y={cardTop}
              rx={16}
              width={CARD_WIDTH}
              height={cardHeight}
              fill="var(--color-primary)"
              opacity={0.08}
            />
          ) : null}
          {photo ? (
            <image
              href={photo}
              x={-AVATAR_SIZE / 2}
              y={card.avatarCenterY - AVATAR_SIZE / 2}
              width={AVATAR_SIZE}
              height={AVATAR_SIZE}
              clipPath={`url(#avatar-${id})`}
              preserveAspectRatio="xMidYMid slice"
            />
          ) : (
            <>
              <circle
                cx={0}
                cy={card.avatarCenterY}
                r={AVATAR_SIZE / 2}
                fill="var(--color-muted)"
              />
              <text
                x={0}
                y={card.avatarCenterY + AVATAR_SIZE * 0.14}
                textAnchor="middle"
                fontSize={16}
                fontWeight={600}
                fill="var(--color-muted-foreground)"
              >
                {initials(nodeDatum.name)}
              </text>
            </>
          )}

          <text
            x={0}
            y={card.nameBaseline}
            textAnchor="middle"
            fontSize={NAME_SIZE}
            fontWeight={NAME_WEIGHT}
            fill="var(--color-foreground)"
          >
            {card.nameLines.map((line, index) => (
              <tspan key={index} x={0} dy={index === 0 ? 0 : NAME_SIZE * NAME_LEADING}>
                {line}
              </tspan>
            ))}
          </text>

          <text
            x={0}
            y={card.roleBaseline}
            textAnchor="middle"
            fontSize={ROLE_SIZE}
            fontWeight={ROLE_WEIGHT}
            fill="var(--color-muted-foreground)"
          >
            {card.roleLines.map((line, index) => (
              <tspan key={index} x={0} dy={index === 0 ? 0 : ROLE_SIZE * ROLE_LEADING}>
                {line}
              </tspan>
            ))}
          </text>

          {/* Separates the department footer from the person's own details. */}
          <line
            x1={-halfContent}
            y1={card.dividerY}
            x2={halfContent}
            y2={card.dividerY}
            stroke="var(--color-border)"
            strokeWidth={1}
            opacity={0.7}
          />

          <circle
            cx={-halfContent + DEPT_DOT_R}
            cy={card.deptBaseline - DEPT_SIZE * 0.32}
            r={DEPT_DOT_R}
            className={style.dot}
          />
          <text
            x={deptTextX}
            y={card.deptBaseline}
            textAnchor="start"
            fontSize={DEPT_SIZE}
            fill="var(--color-muted-foreground)"
          >
            {card.deptLines.map((line, index) => (
              <tspan key={index} x={deptTextX} dy={index === 0 ? 0 : DEPT_SIZE * DEPT_LEADING}>
                {line}
              </tspan>
            ))}
          </text>
          {card.reports ? (
            <text
              x={halfContent}
              y={card.deptBaseline}
              textAnchor="end"
              fontSize={META_SIZE}
              fontWeight={600}
              fill="var(--color-muted-foreground)"
            >
              {card.reports}
            </text>
          ) : null}

          {/* Collapsing is its own control, so clicking the card can open the
              employee drawer without two actions fighting over one area. */}
          {hasChildren ? (
            <g
              className="cursor-pointer"
              role="button"
              tabIndex={-1}
              aria-label={
                isCollapsed
                  ? `Expand ${nodeDatum.name}'s reports`
                  : `Collapse ${nodeDatum.name}'s reports`
              }
              onClick={(event) => {
                event.stopPropagation();
                toggleCollapse(id);
              }}
            >
              <circle
                cx={0}
                cy={toggleY}
                r={TOGGLE_R}
                fill="var(--color-card)"
                stroke="var(--color-border)"
                strokeWidth={1.5}
              />
              <text
                x={0}
                y={toggleY + TOGGLE_R * 0.36}
                textAnchor="middle"
                fontSize={13}
                fontWeight={700}
                fill="var(--color-muted-foreground)"
              >
                {isCollapsed ? "+" : "–"}
              </text>
            </g>
          ) : null}
        </g>
      );
    },
    [selectedId, department, collapsedIds, toggleCollapse],
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
              placeholder="Search name, role or department"
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
              viewerAdjusted.current = true;
              const v = viewportRef.current;
              updateViewport(clampZoom(v.zoom + ZOOM_STEP), v.x, v.y);
            }}
            aria-label="Zoom in"
          >
            <ZoomIn className="size-4" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              viewerAdjusted.current = true;
              const v = viewportRef.current;
              // The floor keeps card text legible: below roughly 0.45 the name stops being
              // readable, so zooming out stops there and the user pans instead.
              updateViewport(clampZoom(v.zoom - ZOOM_STEP), v.x, v.y);
            }}
            aria-label="Zoom out"
          >
            <ZoomOut className="size-4" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              viewerAdjusted.current = false;
              // Re-frame the tree rather than returning to a hard-coded zoom, so
              // Reset means "show me everything" on a phone and a desktop alike.
              if (!fitToContents()) {
                updateViewport(defaultZoom, DEFAULT_TRANSLATE.x, DEFAULT_TRANSLATE.y);
              }
            }}
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
            <div className="flex h-[680px] flex-col items-center justify-center gap-4" aria-hidden>
              <LoadingRegion label="Loading the org chart" />
              <div className="flex flex-col items-center gap-3">
                <Skeleton className="size-12 rounded-full" />
                <Skeleton className="h-4 w-44" />
                <Skeleton className="h-3 w-28" />
              </div>
              <div className="mt-6 grid grid-cols-3 gap-8 opacity-60">
                {[0, 1, 2].map((column) => (
                  <div key={column} className="flex flex-col items-center gap-8">
                    <Skeleton className="h-44 w-62 rounded-2xl" />
                    <Skeleton className="h-44 w-62 rounded-2xl" />
                  </div>
                ))}
              </div>
            </div>
          ) : forest.length === 0 ? (
            // The error, or the empty org, is already explained above. Mounting
            // the chart here would only draw a placeholder card.
            <div className="flex h-[680px] items-center justify-center px-6">
              <EmptyState
                className="border-0"
                icon={Users}
                title="There is nobody to chart yet"
                description="Once employees are added with a manager, the hierarchy appears here automatically."
              />
            </div>
          ) : (
            <div
              ref={chartHostRef}
              className="h-[clamp(560px,72vh,980px)] w-full"
              // Scrolling or dragging is the viewer taking over, after which the
              // chart stops re-framing itself on resize. Wheel and pointer are
              // unambiguous user gestures; `onUpdate` is not, because react-d3-tree
              // also fires it in response to the props this component sets itself.
              onWheel={() => {
                viewerAdjusted.current = true;
              }}
              onPointerDown={() => {
                viewerAdjusted.current = true;
              }}
            >
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
                // Folding is handled above (see `collapsedIds`), so react-d3-tree's
                // own `collapsible` is left off.
                //
                // `scaleExtent` is not optional in effect: react-d3-tree defaults
                // it to { min: 0.1, max: 1 }, which silently clamped every zoom to
                // 1 — the zoom-in button did nothing after one click and wheel zoom
                // could not go further either. These bounds match the toolbar's own
                // limits, so the floor stays high enough for card text to be read.
                scaleExtent={{ min: MIN_ZOOM, max: MAX_ZOOM }}
                // `initialDepth` is deliberately not set. react-d3-tree collapses a
                // node when `depth >= initialDepth`, so the `-1` this used to pass
                // marked *every* node collapsed and pruned the whole tree at the
                // root — the chart rendered one card and no connectors. Left
                // undefined, nodes default to expanded.
                depthFactor={MAX_CARD_HEIGHT + 26}
                nodeSize={{ x: CARD_WIDTH + 48, y: MAX_CARD_HEIGHT + 26 }}
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
