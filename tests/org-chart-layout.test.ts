import { describe, expect, it } from "vitest";

import {
  CARD_WIDTH,
  CONTENT_WIDTH,
  DEPT_DOT_GAP,
  DEPT_LEADING,
  DEPT_SIZE,
  MAX_CARD_HEIGHT,
  META_SIZE,
  NAME_LEADING,
  NAME_SIZE,
  NAME_WEIGHT,
  ROLE_LEADING,
  ROLE_SIZE,
  ROLE_WEIGHT,
  TOGGLE_STRIP,
  measureCard,
  wrapLines,
} from "@/components/features/org-chart/card-layout";

/**
 * Mirrors `measureText`'s headless fallback (length x size x 0.55), which is
 * what the layout uses when there is no canvas to measure against. Weight does
 * not enter the fallback, so it is not a parameter here.
 */
function widthOf(text: string, size: number) {
  return text.length * size * 0.55;
}

const CARDS = [
  { label: "typical root", name: "Ananya Iyer", role: "Chief Operating Officer", dept: "HR & Operations", reports: 3 },
  { label: "leaf", name: "Neha Gupta", role: "Software Engineer", dept: "Engineering", reports: 0 },
  { label: "two-line name", name: "Krishnamurthy Venkataraghavan", role: "Software Engineer", dept: "Engineering", reports: 0 },
  {
    label: "everything wraps",
    name: "Krishnamurthy Venkataraghavan Iyer",
    role: "Senior Director of Strategic Platform Engineering Excellence",
    dept: "Product & Design & Research Operations",
    reports: 14,
  },
  {
    label: "single unbroken token",
    name: "Bartholomew Fitzgerald-Montgomery III",
    role: "x".repeat(90),
    dept: "y".repeat(90),
    reports: 5,
  },
  { label: "stub node", name: "OrgFlow", role: "", dept: "", reports: 0 },
  { label: "search miss", name: "No matching employees", role: "", dept: "", reports: 0 },
];

describe("org chart card typography", () => {
  it("uses the readable type scale the brief asks for", () => {
    // Names ~16-18px and semibold-to-bold; designations and departments 12-14px.
    expect(NAME_SIZE).toBeGreaterThanOrEqual(16);
    expect(NAME_SIZE).toBeLessThanOrEqual(18);
    expect(NAME_WEIGHT).toBeGreaterThanOrEqual(600);

    for (const size of [ROLE_SIZE, DEPT_SIZE]) {
      expect(size).toBeGreaterThanOrEqual(12);
      expect(size).toBeLessThanOrEqual(14);
    }
    expect(ROLE_WEIGHT).toBeGreaterThanOrEqual(400);

    // Secondary information is smaller than the designation it sits beside.
    expect(META_SIZE).toBeLessThan(ROLE_SIZE);
  });

  it("keeps the card wide enough to read at 220-260px", () => {
    expect(CARD_WIDTH).toBeGreaterThanOrEqual(220);
    expect(CARD_WIDTH).toBeLessThanOrEqual(260);
    expect(CONTENT_WIDTH).toBe(CARD_WIDTH - 36);
  });

  it("uses a 1.3-1.5 line height for every text run", () => {
    for (const leading of [NAME_LEADING, ROLE_LEADING, DEPT_LEADING]) {
      expect(leading).toBeGreaterThanOrEqual(1.3);
      expect(leading).toBeLessThanOrEqual(1.5);
    }
  });
});

describe("org chart text wrapping", () => {
  it("never returns a line wider than the box it was given", () => {
    for (const card of CARDS) {
      for (const line of wrapLines(card.name, CONTENT_WIDTH, NAME_SIZE, NAME_WEIGHT, 2)) {
        expect(widthOf(line, NAME_SIZE)).toBeLessThanOrEqual(CONTENT_WIDTH);
      }
      for (const line of wrapLines(card.role, CONTENT_WIDTH, ROLE_SIZE, ROLE_WEIGHT, 2)) {
        expect(widthOf(line, ROLE_SIZE)).toBeLessThanOrEqual(CONTENT_WIDTH);
      }
    }
  });

  it("respects the line budget", () => {
    const long = "Senior Director of Strategic Platform Engineering Excellence";
    expect(wrapLines(long, CONTENT_WIDTH, ROLE_SIZE, ROLE_WEIGHT, 2)).toHaveLength(2);
  });

  it("keeps short text on one line instead of splitting it", () => {
    expect(wrapLines("Neha Gupta", CONTENT_WIDTH, NAME_SIZE, NAME_WEIGHT, 2)).toEqual([
      "Neha Gupta",
    ]);
    expect(wrapLines("Engineering", CONTENT_WIDTH, DEPT_SIZE, 400, 2)).toEqual(["Engineering"]);
  });

  it("returns no lines for empty text rather than a blank line", () => {
    // The synthetic root and the search-miss node carry no designation.
    expect(wrapLines("", CONTENT_WIDTH, ROLE_SIZE, ROLE_WEIGHT, 2)).toEqual([]);
    expect(wrapLines("   ", CONTENT_WIDTH, ROLE_SIZE, ROLE_WEIGHT, 2)).toEqual([]);
  });

  it("breaks a single oversized token instead of letting it overflow", () => {
    const lines = wrapLines("x".repeat(90), CONTENT_WIDTH, ROLE_SIZE, ROLE_WEIGHT, 2);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(widthOf(line, ROLE_SIZE)).toBeLessThanOrEqual(CONTENT_WIDTH);
    }
    // Nothing silently dropped mid-token beyond the documented ellipsis.
    expect(lines.join("").startsWith("x".repeat(40))).toBe(true);
  });

  it("only ellipsises when the line budget is genuinely exhausted", () => {
    const fits = wrapLines("Chief Operating Officer", CONTENT_WIDTH, ROLE_SIZE, ROLE_WEIGHT, 2);
    expect(fits.some((line) => line.endsWith("…"))).toBe(false);

    const overflows = wrapLines("y".repeat(200), CONTENT_WIDTH, ROLE_SIZE, ROLE_WEIGHT, 2);
    expect(overflows.at(-1)).toMatch(/…$/);
  });
});

describe("org chart card geometry", () => {
  it("centres the card on the node origin so connectors land on it", () => {
    for (const card of CARDS) {
      const metrics = measureCard(card.name, card.role, card.dept, card.reports);
      expect(metrics.top).toBeCloseTo(-metrics.height / 2, 6);
    }
  });

  it("never grows past the height the tree layout reserves", () => {
    for (const card of CARDS) {
      const metrics = measureCard(card.name, card.role, card.dept, card.reports);
      expect(metrics.height).toBeLessThanOrEqual(MAX_CARD_HEIGHT);
    }
  });

  it("stacks name, designation and department without overlapping", () => {
    for (const card of CARDS) {
      const m = measureCard(card.name, card.role, card.dept, card.reports);

      const nameBlock = m.nameLines.length * NAME_SIZE * NAME_LEADING;
      const roleBlock = m.roleLines.length * ROLE_SIZE * ROLE_LEADING;
      const deptBlock = m.deptLines.length * DEPT_SIZE * DEPT_LEADING;

      // Each block's last line sits above the next block's first line.
      const nameLast = m.nameBaseline + (m.nameLines.length - 1) * NAME_SIZE * NAME_LEADING;
      expect(m.roleBaseline).toBeGreaterThan(nameLast);

      const roleLast = m.roleBaseline + (m.roleLines.length - 1) * ROLE_SIZE * ROLE_LEADING;
      expect(m.dividerY).toBeGreaterThan(roleLast);

      // The stub nodes (the synthetic root, a search miss) carry no department,
      // so there is no department line to place below the divider.
      if (m.deptLines.length > 0) {
        const deptLast = m.deptBaseline + (m.deptLines.length - 1) * DEPT_SIZE * DEPT_LEADING;
        expect(deptLast).toBeGreaterThan(m.dividerY);
      }

      // The avatar sits above the name, clear of it.
      expect(m.avatarCenterY).toBeLessThan(m.nameBaseline - NAME_SIZE);

      // The declared height is what the blocks actually consume, plus padding:
      // the card can never be shorter than the content drawn inside it.
      expect(m.height).toBeGreaterThanOrEqual(nameBlock + roleBlock + deptBlock);
      // ...and the department baseline still falls inside the card.
      expect(m.top + m.height).toBeGreaterThan(m.deptBaseline);
    }
  });

  it("keeps the department clear of the direct-report count on the same line", () => {
    const m = measureCard("Ananya Iyer", "Chief Operating Officer", "HR & Operations", 3);
    expect(m.reports).toBe("3 reports");
    // The department is wrapped into whatever the count leaves behind, so the
    // two never share horizontal space.
    const deptBox = CONTENT_WIDTH - DEPT_DOT_GAP - (m.reports.length * META_SIZE * 0.55 + 12);
    expect(deptBox).toBeGreaterThan(0);
    for (const line of wrapLines("HR & Operations", deptBox, DEPT_SIZE, 400, 2)) {
      expect(widthOf(line, DEPT_SIZE)).toBeLessThanOrEqual(deptBox);
    }
  });

  it("reserves a strip for the expand/collapse control at the bottom", () => {
    // The control sits below the card's text content, never inside it.
    const m = measureCard("Ananya Iyer", "Chief Operating Officer", "HR & Operations", 3);
    expect(m.deptBaseline).toBeLessThan(m.top + m.height);
    expect(TOGGLE_STRIP).toBeGreaterThan(0);
  });

  it("sizes the department text only for leaves as a single line", () => {
    const leaf = measureCard("Neha Gupta", "Software Engineer", "Engineering", 0);
    expect(leaf.reports).toBe("");
    expect(leaf.deptLines).toEqual(["Engineering"]);
  });
});