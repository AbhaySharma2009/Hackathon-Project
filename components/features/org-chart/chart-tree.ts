/**
 * Pure tree logic for the org chart: shaping the server's forest, searching it,
 * folding branches, and choosing a zoom that suits the viewport.
 *
 * No React and no rendering, so every rule the chart depends on can be asserted
 * directly in tests instead of through the DOM.
 */
import type { OrgNode } from "@/shared/types";

/** Fold key for the multi-root wrapper — not an employee id. */
export const ROOTS_KEY = "__org_roots__";

/**
 * Zoom limits, shared by the toolbar buttons and the tree's `scaleExtent` so the
 * two can never disagree. The floor is where card text stops being readable —
 * below it the viewer pans instead of zooming out.
 */
export const MIN_ZOOM = 0.45;
export const MAX_ZOOM = 1.8;
export const ZOOM_STEP = 0.15;
export const DEFAULT_ZOOM = 0.85;
export const DEFAULT_TRANSLATE = { x: 400, y: 80 };

/**
 * The zoom to draw with before the tree has been measured.
 *
 * A card is 248px wide before scaling, so at the desktop zoom only two fit across
 * a phone; narrow viewports therefore start smaller. This is a starting guess
 * only — `fitViewport` takes over as soon as the tree is on screen, and this
 * value is what the chart falls back to if measuring fails.
 */
export function fittedZoomFor(width: number): number {
  if (width < 640) return 0.6;
  if (width < 1024) return 0.72;
  return DEFAULT_ZOOM;
}

/** Keeps a zoom inside the same limits the toolbar buttons and `scaleExtent` use. */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * The viewport that shows a whole tree at once.
 *
 * A fixed zoom cannot do this. The seed hierarchy is six levels deep, so at the
 * desktop zoom only the top three rows landed inside the chart's own height and
 * everyone below was clipped off the bottom with nothing on screen to suggest
 * they existed. Measuring the rendered tree and fitting it to the container
 * keeps the whole org visible on load, and stays correct as the org grows or
 * reshapes instead of going stale against a hard-coded number.
 *
 * `box` is the tree's natural extent in the chart's own coordinates; `container`
 * is the chart's pixel size. The zoom is clamped to the same limits as
 * everything else, so a tree too large to fit is shown as large as still
 * readable rather than as a smear.
 */
export function fitViewport(
  box: { x: number; y: number; width: number; height: number },
  container: { width: number; height: number },
  margin = 24,
): { zoom: number; x: number; y: number } {
  const usableWidth = Math.max(1, container.width - margin * 2);
  const usableHeight = Math.max(1, container.height - margin * 2);
  const zoom = clampZoom(Math.min(usableWidth / box.width, usableHeight / box.height));
  return {
    zoom,
    x: container.width / 2 - (box.x + box.width / 2) * zoom,
    y: container.height / 2 - (box.y + box.height / 2) * zoom,
  };
}

/**
 * react-d3-tree's `attributes` is `Record<string, string | number | boolean>`, so
 * a nullable photo URL cannot live there. Empty string means "no photo".
 */
export type ChartNode = {
  name: string;
  attributes: {
    id: string;
    photo: string;
    role: string;
    department: string;
    reports: number;
    /**
     * True only for the wrapper react-d3-tree needs when the org has more than
     * one top-level employee. It stands for no person, so it must never be
     * clickable as one and must never open an employee record.
     */
    synthetic?: boolean;
  };
  children?: ChartNode[];
};

export function toChartNode(node: OrgNode): ChartNode {
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

export function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

/**
 * Keeps every ancestor of a match, and the match itself, so searching for
 * "Neha" shows her reporting line rather than a floating node. Matching covers
 * name, designation and department, so "HR & Operations" finds that team even
 * though no individual title contains the phrase.
 */
export function filterChartTree(node: ChartNode, search: string): ChartNode | null {
  const needle = search.trim().toLowerCase();
  const matches =
    needle === "" ||
    node.name.toLowerCase().includes(needle) ||
    node.attributes.role.toLowerCase().includes(needle) ||
    node.attributes.department.toLowerCase().includes(needle);

  const children = (node.children ?? [])
    .map((child) => filterChartTree(child, needle))
    .filter((child): child is ChartNode => child !== null);

  // A node survives when it matches itself, or when it is on the path to a match.
  if (!matches && children.length === 0) return null;

  return { ...node, children: children.length > 0 ? children : undefined };
}

/**
 * Folds a branch by dropping its children, at *every* depth.
 *
 * This has to recurse: applying it only to the roots made the +/− control a
 * no-op on every manager below the top of the chart, because their id was never
 * checked. Leaves keep their object identity so React can skip them.
 *
 * Folding is destructive — a folded node's children are gone from the result —
 * so this must always be re-applied to the pristine forest rather than to an
 * already-folded tree. That is what the component does: `chartData` is derived
 * from `forest` on every render, so lifting a fold restores the whole subtree.
 */
export function applyCollapse(
  node: ChartNode,
  collapsedIds: ReadonlySet<string>,
  ignoreFold: boolean,
): ChartNode {
  if (!ignoreFold && collapsedIds.has(node.attributes.id)) {
    return { ...node, children: undefined };
  }
  if (!node.children?.length) return node;
  return {
    ...node,
    children: node.children.map((child) => applyCollapse(child, collapsedIds, ignoreFold)),
  };
}

/** Every employee id in a forest, which is what search matching walks. */
export function flattenChartTree(roots: ChartNode[]): ChartNode[] {
  const out: ChartNode[] = [];
  const walk = (node: ChartNode) => {
    out.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}
