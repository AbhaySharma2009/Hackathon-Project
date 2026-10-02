import { describe, expect, it } from "vitest";

import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  ROOTS_KEY,
  applyCollapse,
  clampZoom,
  filterChartTree,
  fitViewport,
  flattenChartTree,
  fittedZoomFor,
  initials,
  toChartNode,
  type ChartNode,
} from "@/components/features/org-chart/chart-tree";

/** The seeded org shape, as `get_org_tree()` returns it. */
const tree = (): ChartNode => ({
  name: "Ananya Iyer",
  attributes: {
    id: "a",
    photo: "",
    role: "Chief Operating Officer",
    department: "HR & Operations",
    reports: 1,
  },
  children: [
    {
      name: "Meera Krishnan",
      attributes: {
        id: "b",
        photo: "",
        role: "Head of People Operations",
        department: "HR & Operations",
        reports: 1,
      },
      children: [
        {
          name: "Aditya Rao",
          attributes: {
            id: "c",
            photo: "",
            role: "Chief Executive Officer",
            department: "Engineering",
            reports: 3,
          },
          children: [
            {
              name: "Rohan Iyer",
              attributes: {
                id: "d",
                photo: "",
                role: "Head of People & Operations",
                department: "HR & Operations",
                reports: 0,
              },
            },
            {
              name: "Sanjay Kapoor",
              attributes: {
                id: "e",
                photo: "",
                role: "Engineering Manager",
                department: "Engineering",
                reports: 2,
              },
              children: [
                {
                  name: "Neha Gupta",
                  attributes: {
                    id: "f",
                    photo: "",
                    role: "Senior Backend Engineer",
                    department: "Engineering",
                    reports: 0,
                  },
                },
                {
                  name: "Priya Nair",
                  attributes: {
                    id: "g",
                    photo: "",
                    role: "Frontend Engineer",
                    department: "Engineering",
                    reports: 0,
                  },
                },
              ],
            },
            {
              name: "Vikram Sethi",
              attributes: {
                id: "h",
                photo: "",
                role: "Head of Sales",
                department: "Sales",
                reports: 0,
              },
            },
          ],
        },
      ],
    },
  ],
});

const names = (nodes: (ChartNode | null)[]) =>
  flattenChartTree(nodes.filter((n): n is ChartNode => n !== null)).map((n) => n.name).sort();

const one = (node: ChartNode) => [node];

describe("search", () => {
  it("matches on name", () => {
    expect(names(one(filterChartTree(tree(), "Neha")!))).toEqual([
      "Aditya Rao",
      "Ananya Iyer",
      "Meera Krishnan",
      "Neha Gupta",
      "Sanjay Kapoor",
    ]);
  });

  it("matches on designation", () => {
    expect(names(one(filterChartTree(tree(), "Engineering Manager")!))).toContain("Sanjay Kapoor");
  });

  it("matches on department", () => {
    // No individual title contains "HR & Operations", so this only passes if the
    // department is part of the match.
    const found = names(one(filterChartTree(tree(), "HR & Operations")!));
    expect(found).toContain("Ananya Iyer");
    expect(found).toContain("Meera Krishnan");
    expect(found).toContain("Rohan Iyer");
    // The Sales engineer is not in HR & Operations and is not on a path to one.
    expect(found).not.toContain("Vikram Sethi");
  });

  it("keeps ancestors so the reporting line stays intact", () => {
    // Sanjay is a leaf match's parent; without him Neha would float free.
    const found = names(one(filterChartTree(tree(), "Priya")!));
    expect(found).toContain("Sanjay Kapoor");
    expect(found).toContain("Priya Nair");
  });

  it("returns the whole tree for an empty search", () => {
    expect(flattenChartTree(one(filterChartTree(tree(), "")!))).toHaveLength(8);
  });

  it("ignores surrounding whitespace and case", () => {
    expect(names(one(filterChartTree(tree(), "  NEHA  ")!))).toContain("Neha Gupta");
  });

  it("returns null when nothing matches", () => {
    expect(filterChartTree(tree(), "zzz-no-such-person")).toBeNull();
  });

  it("prunes non-matching branches", () => {
    const found = names(one(filterChartTree(tree(), "Neha")!));
    expect(found).not.toContain("Vikram Sethi");
    expect(found).not.toContain("Rohan Iyer");
  });
});

describe("expand and collapse", () => {
  it("folds a root branch", () => {
    const folded = applyCollapse(tree(), new Set(["a"]), false);
    expect(folded.children).toBeUndefined();
    expect(flattenChartTree([folded])).toHaveLength(1);
  });

  it("folds a manager that is not a root", () => {
    // This is the regression: fold state used to be checked on roots only, so
    // every manager below the top of the chart had a dead +/− control.
    const folded = applyCollapse(tree(), new Set(["c"]), false);
    expect(flattenChartTree([folded])).toHaveLength(3); // Ananya, Meera, Aditya
    const [meera] = folded.children!;
    expect(meera.children![0].children).toBeUndefined();
  });

  it("folds a middle manager and leaves siblings alone", () => {
    const folded = applyCollapse(tree(), new Set(["e"]), false);
    const aditya = folded.children![0].children![0];
    const byId = Object.fromEntries(
      (aditya.children ?? []).map((c) => [c.attributes.id, c]),
    );
    expect(byId.e.children).toBeUndefined(); // Sanjay folded
    expect(byId.d.children).toBeUndefined(); // Rohan is a leaf anyway
    expect(byId.h.name).toBe("Vikram Sethi"); // untouched sibling survives
    expect(flattenChartTree([folded])).toHaveLength(6);
  });

  it("restores the full subtree when the fold is lifted", () => {
    // Folding is derived, never stored: the component always re-applies it to
    // the pristine forest, so an empty fold set brings everyone back.
    const folded = applyCollapse(tree(), new Set(["c"]), false);
    expect(flattenChartTree([folded])).toHaveLength(3);
    const rebuilt = applyCollapse(tree(), new Set(), false);
    expect(flattenChartTree([rebuilt])).toHaveLength(8);
  });

  it("ignores fold state while a search is active", () => {
    // Otherwise a match could sit inside a branch the viewer had closed.
    const found = applyCollapse(filterChartTree(tree(), "Neha")!, new Set(["e"]), true);
    expect(names([found])).toContain("Neha Gupta");
  });

  it("keeps leaf identity so React can skip them", () => {
    const rohan = tree().children![0].children![0].children![0];
    expect(applyCollapse(rohan, new Set(), false)).toBe(rohan);
  });
});

describe("fitting the whole tree on screen", () => {
  const container = { width: 1200, height: 680 };
  // The seed hierarchy's natural extent, as `getBBox()` reports it.
  const tree = { x: -450, y: -88, width: 899, height: 1207 };

  it("shows every node on load instead of clipping the lower rows", () => {
    const fit = fitViewport(tree, container);
    // The old fixed zoom showed 3 of 8 rows; this has to show all of it.
    expect(fit.zoom * tree.height).toBeLessThanOrEqual(container.height);
    expect(fit.zoom * tree.width).toBeLessThanOrEqual(container.width);
    expect(fit.zoom).toBeLessThan(DEFAULT_ZOOM);
  });

  it("centres the tree in the chart", () => {
    const fit = fitViewport(tree, container);
    const treeCentre = tree.x + tree.width / 2;
    const renderedCentre = fit.x + treeCentre * fit.zoom;
    expect(renderedCentre).toBeCloseTo(container.width / 2, 6);
    const treeCentreY = tree.y + tree.height / 2;
    const renderedCentreY = fit.y + treeCentreY * fit.zoom;
    expect(renderedCentreY).toBeCloseTo(container.height / 2, 6);
  });

  it("scales a short tree up to fill the chart", () => {
    const small = { x: -100, y: -60, width: 300, height: 200 };
    const fit = fitViewport(small, container);
    // Height is the binding constraint here.
    expect(fit.zoom).toBeGreaterThan(DEFAULT_ZOOM);
    expect(fit.zoom * 200).toBeLessThanOrEqual(680);
  });

  it("never zooms below the legibility floor or above the ceiling", () => {
    const huge = { x: 0, y: 0, width: 20000, height: 30000 };
    const fit = fitViewport(huge, container);
    expect(fit.zoom).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(-99)).toBe(MIN_ZOOM);
  });

  it("survives a degenerate container without dividing by zero", () => {
    expect(() => fitViewport(tree, { width: 0, height: 0 })).not.toThrow();
    const fit = fitViewport(tree, { width: 0, height: 0 });
    expect(Number.isFinite(fit.zoom)).toBe(true);
    expect(Number.isFinite(fit.x)).toBe(true);
    expect(Number.isFinite(fit.y)).toBe(true);
  });
});

describe("multiple top-level employees", () => {
  // A second, genuinely separate top-level employee.
  const soloRoot = (): ChartNode => ({
    name: "Farida Khan",
    attributes: {
      id: "k",
      photo: "",
      role: "General Counsel",
      department: "Product & Design",
      reports: 0,
    },
  });
  const forest = (): ChartNode[] => [tree(), soloRoot()];

  it("treats every root independently", () => {
    expect(forest()).toHaveLength(2);
    expect(names(forest())).toHaveLength(9);
  });

  it("searches across all roots", () => {
    const hits = forest()
      .map((r) => filterChartTree(r, "General Counsel"))
      .filter((r): r is ChartNode => r !== null);
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe("Farida Khan");
  });

  it("keeps a matching root and prunes the one that does not match", () => {
    const hits = forest()
      .map((r) => filterChartTree(r, "Head of Sales"))
      .filter((r): r is ChartNode => r !== null);
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe("Ananya Iyer");
  });

  it("folds one root without touching the other", () => {
    const [first, second] = forest();
    const folded = [applyCollapse(first, new Set(["a"]), false), second];
    expect(flattenChartTree(folded)).toHaveLength(2);
    expect(folded[1].name).toBe("Farida Khan");
  });

  it("uses a fold key that cannot collide with an employee id", () => {
    expect(ROOTS_KEY).not.toBe("");
    expect(forest().some((r) => r.attributes.id === ROOTS_KEY)).toBe(false);
  });
});

describe("missing or odd data", () => {
  it("survives an employee with no children", () => {
    const leaf: ChartNode = {
      name: "Solo",
      attributes: { id: "s", photo: "", role: "Engineer", department: "Engineering", reports: 0 },
    };
    expect(filterChartTree(leaf, "")).toEqual(leaf);
    expect(flattenChartTree([applyCollapse(leaf, new Set(), false)])).toHaveLength(1);
  });

  it("maps a null photo and absent children from the server payload", () => {
    const mapped = toChartNode({
      id: "z",
      name: "No Photo",
      role: "Engineer",
      department: "Engineering",
      photo: null,
      direct_report_count: 0,
    } as never);
    expect(mapped.attributes.photo).toBe("");
    expect(mapped.children).toBeUndefined();
  });

  it("survives an empty forest", () => {
    expect(flattenChartTree([])).toEqual([]);
  });

  it("survives empty strings in searchable fields", () => {
    const odd: ChartNode = {
      name: "Odd",
      attributes: { id: "o", photo: "", role: "", department: "", reports: 0 },
    };
    // No crash, and no accidental match on an empty field.
    expect(() => filterChartTree(odd, "engineering")).not.toThrow();
    expect(filterChartTree(odd, "engineering")).toBeNull();
    // An empty needle still returns the node itself.
    expect(filterChartTree(odd, "")).toEqual(odd);
  });
});

describe("zoom fitting", () => {
  it("opens lower on narrow viewports", () => {
    expect(fittedZoomFor(390)).toBeLessThan(fittedZoomFor(768));
    expect(fittedZoomFor(768)).toBeLessThan(fittedZoomFor(1440));
    expect(fittedZoomFor(1440)).toBe(DEFAULT_ZOOM);
  });

  it("never fits below the readable floor or above the ceiling", () => {
    for (const width of [320, 390, 640, 768, 1024, 1440, 2560]) {
      expect(fittedZoomFor(width)).toBeGreaterThanOrEqual(MIN_ZOOM);
      expect(fittedZoomFor(width)).toBeLessThanOrEqual(MAX_ZOOM);
    }
  });
});

describe("initials", () => {
  it("uses at most the first two words", () => {
    expect(initials("Ananya Iyer")).toBe("AI");
    expect(initials("Priya Nair")).toBe("PN");
    expect(initials("Krishnamurthy Venkataraghavan Iyer")).toBe("KV");
    expect(initials("Cher")).toBe("C");
  });
});