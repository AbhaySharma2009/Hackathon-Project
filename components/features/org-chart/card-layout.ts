/**
 * Card layout for the org chart.
 *
 * Pure geometry and text measurement — no React — so the numbers that decide
 * whether a card is readable can be asserted directly in tests.
 */
/**
 * Card geometry.
 *
 * The card is sized from its content rather than fixed, but it is always
 * centred on the node origin: react-d3-tree terminates every connector at that
 * origin, so a centred card keeps each link landing on the middle of its node
 * instead of on the edge of a taller or shorter neighbour.
 */
export const CARD_WIDTH = 248;
export const CARD_PAD_X = 18;
export const CARD_PAD_TOP = 14;
export const CARD_PAD_BOTTOM = 14;
export const CONTENT_WIDTH = CARD_WIDTH - CARD_PAD_X * 2;

export const AVATAR_SIZE = 48;
export const AVATAR_GAP = 12;

export const NAME_SIZE = 17;
export const NAME_WEIGHT = 700;
export const NAME_LEADING = 1.3;
export const NAME_MAX_LINES = 2;
export const NAME_GAP = 3;

export const ROLE_SIZE = 13.5;
export const ROLE_WEIGHT = 500;
export const ROLE_LEADING = 1.4;
export const ROLE_MAX_LINES = 2;
export const ROLE_GAP = 8;

export const DEPT_SIZE = 12.5;
export const DEPT_LEADING = 1.4;
export const DEPT_MAX_LINES = 2;
export const DEPT_DOT_R = 4;
export const DEPT_DOT_GAP = 16;

export const META_SIZE = 12.5;

/** A real ellipsis glyph, not three dots: it is narrower, so more of the word
 *  before it survives on a line that is already at its budget. */
const ELLIPSIS = "…";

/** Reserved band along the bottom edge for the expand/collapse control, so the
 *  control straddles the border without ever sitting over employee text. */
export const TOGGLE_STRIP = 18;
export const TOGGLE_R = 10;

/** Widest card the stack above can produce, used to keep a card from being
 *  drawn into its connector when the text runs to the full line budget. */
export const MAX_CARD_HEIGHT =
  CARD_PAD_TOP +
  AVATAR_SIZE +
  AVATAR_GAP +
  NAME_MAX_LINES * NAME_SIZE * NAME_LEADING +
  NAME_GAP +
  ROLE_MAX_LINES * ROLE_SIZE * ROLE_LEADING +
  ROLE_GAP +
  DEPT_MAX_LINES * DEPT_SIZE * DEPT_LEADING +
  CARD_PAD_BOTTOM +
  TOGGLE_STRIP;

/**
 * Text metrics for the card layout.
 *
 * An SVG `<text>` does not wrap: long designations either run off the card or
 * have to be cut at a hard character count, which is what left names and titles
 * unreadable before. Wrapping is measured here against the same Geist stack the
 * page renders in, and drawn as one `<tspan>` per line.
 *
 * `<Tree>` is mounted only after the fetch resolves (the first paint is the
 * loading skeleton), so this never runs during SSR and there is no server-side
 * measurement for the browser to disagree with at hydration.
 */
let measureContext: CanvasRenderingContext2D | null | undefined;
let chartFontStack = "";

function fontStack(): string {
  if (chartFontStack) return chartFontStack;
  if (typeof document === "undefined") return "system-ui, sans-serif";
  chartFontStack =
    getComputedStyle(document.documentElement).getPropertyValue("--font-geist-sans").trim() ||
    "system-ui, sans-serif";
  return chartFontStack;
}

export function measureText(text: string, size: number, weight: number): number {
  // Without a canvas (SSR, or a locked-down browser) the fallback only has to be
  // close enough to keep wrapping on a sensible number of lines.
  const fallback = text.length * size * 0.55;
  if (typeof document === "undefined") return fallback;
  if (measureContext === undefined) {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  const context = measureContext;
  if (!context) return fallback;
  context.font = `${weight} ${size}px ${fontStack()}`;
  return context.measureText(text).width;
}

/** The longest run of whole words from `words` that fits `maxWidth`. */
function takeWords(words: string[], maxWidth: number, size: number, weight: number) {
  let text = "";
  let count = 0;
  for (const word of words) {
    const candidate = text ? `${text} ${word}` : word;
    if (text && measureText(candidate, size, weight) > maxWidth) break;
    text = candidate;
    count += 1;
  }
  return { text, count };
}

/** A token too wide for the card on its own (a long compound, a pasted URL) is
 *  split by character rather than left to overflow the card edge. */
function breakToken(token: string, maxWidth: number, size: number, weight: number): string[] {
  if (measureText(token, size, weight) <= maxWidth) return [token];
  const chunks: string[] = [];
  let current = "";
  for (const char of token) {
    if (current && measureText(current + char, size, weight) > maxWidth) {
      chunks.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Drops trailing characters from `text` until it and `suffix` fit `maxWidth`. */
function trimToWidth(
  text: string,
  maxWidth: number,
  size: number,
  weight: number,
  suffix: string,
): string {
  let out = text;
  while (out.length > 0 && measureText(out + suffix, size, weight) > maxWidth) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Greedy word wrap into at most `maxLines` lines.
 *
 * Only text that genuinely exceeds the budget is cut, and it is cut on a word
 * boundary with room left for the ellipsis — the old fixed character slice cut
 * mid-word regardless of how much room the card actually had.
 */
export function wrapLines(
  text: string,
  maxWidth: number,
  size: number,
  weight: number,
  maxLines: number,
): string[] {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) return [];

  const words: string[] = [];
  for (const token of clean.split(" ")) {
    words.push(...breakToken(token, maxWidth, size, weight));
  }

  const lines: string[] = [];
  let queue = words;

  while (queue.length > 0) {
    const isLastLine = lines.length === maxLines - 1;
    const { text: line, count } = takeWords(queue, maxWidth, size, weight);

    if (count === queue.length || !isLastLine) {
      lines.push(line);
      queue = queue.slice(count);
      continue;
    }

    // Out of line budget with text left over. `takeWords` always keeps at least
    // one word even when that word is wider than the box, so the room reserved
    // for the ellipsis has to be enforced on the result, not just on the input.
    lines.push(`${trimToWidth(line, maxWidth, size, weight, ELLIPSIS).trim()}…`);
    queue = [];
  }

  return lines;
}

export type CardMetrics = {
  height: number;
  top: number;
  avatarCenterY: number;
  nameBaseline: number;
  nameLines: string[];
  roleBaseline: number;
  roleLines: string[];
  dividerY: number;
  deptBaseline: number;
  deptLines: string[];
  reports: string;
};

export function measureCard(name: string, role: string, dept: string, reports: number): CardMetrics {
  const nameLines = wrapLines(name, CONTENT_WIDTH, NAME_SIZE, NAME_WEIGHT, NAME_MAX_LINES);
  const roleLines = wrapLines(role, CONTENT_WIDTH, ROLE_SIZE, ROLE_WEIGHT, ROLE_MAX_LINES);

  // The direct-report count shares the department's line. The department is
  // wrapped into whatever horizontal space is left, so the two can never overlap
  // even when the department runs to a second line.
  const reportsText = reports > 0 ? `${reports} report${reports === 1 ? "" : "s"}` : "";
  const reportsWidth = reportsText ? measureText(reportsText, META_SIZE, 600) : 0;
  const deptWidth = CONTENT_WIDTH - DEPT_DOT_GAP - (reportsText ? reportsWidth + 12 : 0);
  const deptLines = wrapLines(dept, deptWidth, DEPT_SIZE, 400, DEPT_MAX_LINES);

  const nameBlock = nameLines.length * NAME_SIZE * NAME_LEADING;
  const roleBlock = roleLines.length * ROLE_SIZE * ROLE_LEADING;
  const deptBlock = deptLines.length * DEPT_SIZE * DEPT_LEADING;

  const height =
    CARD_PAD_TOP +
    AVATAR_SIZE +
    AVATAR_GAP +
    nameBlock +
    NAME_GAP +
    roleBlock +
    ROLE_GAP +
    deptBlock +
    CARD_PAD_BOTTOM;

  const top = -height / 2;

  let cursor = top + CARD_PAD_TOP;
  const avatarCenterY = cursor + AVATAR_SIZE / 2;
  cursor += AVATAR_SIZE + AVATAR_GAP;
  const nameBaseline = cursor + NAME_SIZE;
  cursor += nameBlock + NAME_GAP;
  const roleBaseline = cursor + ROLE_SIZE;
  cursor += roleBlock + ROLE_GAP;
  const dividerY = cursor - ROLE_GAP / 2;
  const deptBaseline = cursor + DEPT_SIZE;

  return {
    height,
    top,
    avatarCenterY,
    nameBaseline,
    nameLines,
    roleBaseline,
    roleLines,
    dividerY,
    deptBaseline,
    deptLines,
    reports: reportsText,
  };
}
