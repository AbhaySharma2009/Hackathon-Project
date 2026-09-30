import "server-only";

/**
 * AI-assisted leave requests.
 *
 * The split that matters here: the model *reads* the sentence, and the database
 * *decides*. The model never computes a working-day count, never checks a
 * balance, and never confirms a submission. It produces a draft, the draft is
 * re-validated with zod, and then `validate_leave_request` — the same dry run
 * the leave form uses — produces the verdict.
 *
 * That means a hallucinated draft produces a wrong-looking preview card at worst,
 * never a request the rules would have refused. And nothing is ever submitted
 * from here: the card carries a button that calls POST /api/leave-requests, the
 * identical endpoint the manual form posts to, which re-runs every rule in its own
 * transaction. The model has no tool that can create a request.
 */
import { z } from "zod";
import { LEAVE_TYPES } from "@/server/leave";
import type { ToolContext } from "@/server/ai/tools.employee";

/** The draft the model is asked to produce. Ambiguity is a question, not a guess. */
export const leaveDraftSchema = z
  .object({
    leave_type: z.enum(LEAVE_TYPES, { message: "Choose a leave type." }),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date."),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date."),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((draft) => draft.start_date <= draft.end_date, {
    message: "The start date must be on or before the end date.",
    path: ["end_date"],
  });

export type LeaveDraft = z.infer<typeof leaveDraftSchema>;

/**
 * What the model returns from `parse_leave_request`. Either a usable draft or a
 * question to put back to the employee — never a draft with a guessed field.
 *
 * `text` is the employee's own sentence, passed through verbatim. Models
 * reliably hand back a free-text field even when the schema does not offer one,
 * and having it declared means the server can resolve the dates itself rather
 * than depend on the model doing date arithmetic.
 */
export const parseLeaveRequestSchema = z
  .object({
    leave_type: z.enum(LEAVE_TYPES).optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    reason: z.string().trim().max(500).optional(),
    /** The employee's sentence, copied exactly. Used to resolve dates. */
    text: z.string().trim().max(500).optional(),
    /** Set when the sentence is missing something and must not be guessed at. */
    clarification_question: z.string().trim().max(300).optional(),
  })
  .describe(
    "A parsed leave request, or a clarification_question when the type, the year or an end date is missing. " +
      "Always copy the employee's sentence into `text`.",
  );

export type ParsedLeaveRequest = z.infer<typeof parseLeaveRequestSchema>;

/** Draft with the dates filled in, before validation. */
type ResolvedDates = { start_date: string; end_date: string } | { question: string };

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

/** "12th", "12", "12 st" — the ordinal suffix is noise. */
const ORD = String.raw`\s*(?:st|nd|rd|th)?`;
const MONTH_WORD =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";

/**
 * The most common phrasing, and the one that needs its own pattern: the month is
 * written once for a range — "12th to 15th October" — so a day/month pair matcher
 * on its own would only ever see the second day.
 */
const RANGE_DAY_MONTH = new RegExp(
  String.raw`(\d{1,2})${ORD}\s*(?:to|-|–|—|through|until|till|and)\s*(\d{1,2})${ORD}\s*(?:of\s+)?(${MONTH_WORD})\b`,
  "gi",
);
const DAY_MONTH = new RegExp(
  String.raw`\b(\d{1,2})${ORD}\s*(?:of\s+)?(${MONTH_WORD})\b`,
  "gi",
);
const MONTH_DAY = new RegExp(
  String.raw`\b(${MONTH_WORD})\s*(\d{1,2})\b${ORD}`,
  "gi",
);

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/**
 * Resolves "12th to 15th October" into real dates, deterministically.
 *
 * This is date arithmetic, and arithmetic belongs in code rather than in a
 * language model: said in November, "12th to 15th October" means next year, and
 * getting that wrong files a request for a date nobody asked for. The model
 * extracts the intent and the leave type; the year is decided here.
 *
 * Returns a question rather than a guess when the sentence does not contain a
 * month, which is the one case that genuinely cannot be resolved.
 */
export function resolveDatesFromText(text: string, now = new Date()): ResolvedDates {
  const lower = text.toLowerCase();

  // An explicit four-digit year, removed from the working copy so its digits
  // cannot be mistaken for a day — otherwise "October 2027" reads as the 20th.
  const explicitYear = lower.match(/\b(20\d{2})\b/);
  const scrubbed = lower.replace(/\b20\d{2}\b/g, " ");

  // `matchAll`, not `match`: a /g regex's String.match drops capture groups.
  const [first] = [...scrubbed.matchAll(RANGE_DAY_MONTH)];
  if (first) {
    return build(
      Number(first[1]),
      Number(first[2]),
      MONTHS[first[3].toLowerCase()],
      explicitYear,
      now,
    );
  }

  const found: { day: number; month: number }[] = [];
  for (const match of scrubbed.matchAll(DAY_MONTH)) {
    found.push({ day: Number(match[1]), month: MONTHS[match[2].toLowerCase()] });
  }
  for (const match of scrubbed.matchAll(MONTH_DAY)) {
    found.push({ day: Number(match[2]), month: MONTHS[match[1].toLowerCase()] });
  }

  if (found.length === 0) {
    return {
      question:
        "I could not find the dates in that. Which days do you mean — for example, 12 October to 15 October?",
    };
  }

  // The first mention is the start; a second, different day is the end. A single
  // day, or a repeated one, is a one-day request rather than a guess.
  const start = found[0];
  const second = found[1];
  return build(
    start.day,
    second && second.day !== start.day ? second.day : start.day,
    start.month,
    explicitYear,
    now,
  );
}

function build(
  startDay: number,
  endDay: number,
  month: number,
  explicitYear: RegExpMatchArray | null,
  now: Date,
): ResolvedDates {
  if (
    !month ||
    startDay < 1 ||
    startDay > 31 ||
    endDay < 1 ||
    endDay > 31 ||
    month < 1 ||
    month > 12
  ) {
    return { question: "That date does not look like a real day. Could you say it again?" };
  }

  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  // The year is the one in which that day has not yet passed. Today counts as
  // still ahead, so "today" does not jump to next year.
  const yearFor = (day: number) => {
    if (explicitYear) return Number(explicitYear[1]);
    return Date.UTC(now.getUTCFullYear(), month - 1, day) >= todayUtc
      ? now.getUTCFullYear()
      : now.getUTCFullYear() + 1;
  };

  const startYear = yearFor(startDay);
  const endYear = yearFor(endDay);

  return {
    start_date: `${startYear}-${pad(month)}-${pad(startDay)}`,
    end_date: `${endYear}-${pad(month)}-${pad(endDay)}`,
  };
}
export type LeavePreviewCard = {
  type: "leave_preview";
  leave_type: string;
  start_date: string;
  end_date: string;
  days: number;
  available_balance: number | null;
  valid: boolean;
  /**
   * What the model heard, shown in an editable field. `create_leave_request`
   * requires a reason of at least 5 characters, and the assistant will not invent
   * one on the employee's behalf — so this is empty whenever they did not give
   * one, and the card asks for it instead.
   */
  reason: string;
  error?: { code: string; message: string };
  conflicts?: {
    id: string;
    status: string;
    start_date: string;
    end_date: string;
    days: number;
  }[];
};

export type LeaveDraftResult =
  | { kind: "preview"; card: LeavePreviewCard; reply: string }
  | { kind: "clarification"; question: string };

const TYPE_LABEL: Record<string, string> = {
  casual: "casual",
  sick: "sick",
  annual: "annual",
  unpaid: "unpaid",
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Turns the model's draft into a preview card, or into a question.
 *
 * The checks here are deliberately untrusting of the model: a draft with a
 * missing field, a reversed range or a date already in the past becomes a
 * question rather than a card. A past date is the specific case that "12th to
 * 15th October" produces in January, and the system prompt tells the model to
 * infer the next occurrence — so a past date here means it did not.
 */
export async function buildLeavePreview(
  context: ToolContext,
  parsed: ParsedLeaveRequest,
): Promise<LeaveDraftResult> {
  if (parsed.clarification_question) {
    return { kind: "clarification", question: parsed.clarification_question };
  }

  // The model's dates are used when it produced usable ones. When it passed the
  // sentence through instead — which it does reliably — the dates are resolved
  // here, so the year is decided by code rather than by the model.
  let start = parsed.start_date;
  let end = parsed.end_date;

  const hasUsableDates = Boolean(start && end);
  if (!hasUsableDates && parsed.text) {
    const resolved = resolveDatesFromText(parsed.text);
    if ("question" in resolved) {
      return { kind: "clarification", question: resolved.question };
    }
    start = resolved.start_date;
    end = resolved.end_date;
  }

  if (!parsed.leave_type || !start || !end) {
    return {
      kind: "clarification",
      question:
        "I need the leave type and both dates before I can check that. " +
        "For example: casual leave from 12 October to 15 October.",
    };
  }

  const draft = leaveDraftSchema.safeParse({
    leave_type: parsed.leave_type,
    start_date: start,
    end_date: end,
    reason: parsed.reason,
  });

  if (!draft.success) {
    return {
      kind: "clarification",
      question: `I could not read those dates. ${draft.error.issues[0]?.message ?? "Could you say them again as, for example, 12 October to 15 October?"}`,
    };
  }

  if (draft.data.start_date < today()) {
    return {
      kind: "clarification",
      question:
        `Those dates (${draft.data.start_date} to ${draft.data.end_date}) are in the past. ` +
        "Shall I look at the same days next year instead?",
    };
  }

  // The dry run. Same RPC, same transaction shape as the leave form, and it acts
  // on the caller resolved from the session, so it can only ever validate for
  // the signed-in employee.
  const { data, error } = await context.supabase.rpc("validate_leave_request", {
    p_leave_type: draft.data.leave_type,
    p_start: draft.data.start_date,
    p_end: draft.data.end_date,
  });
  if (error) throw error;

  const verdict = data as {
    valid: boolean;
    days: number;
    available_balance: number | null;
    error_code: string | null;
    error_message: string | null;
    conflicts: { id: string; status: string; start_date: string; end_date: string; days: number }[];
  };

  const card: LeavePreviewCard = {
    type: "leave_preview",
    leave_type: draft.data.leave_type,
    start_date: draft.data.start_date,
    end_date: draft.data.end_date,
    days: Number(verdict.days ?? 0),
    available_balance: verdict.available_balance,
    valid: Boolean(verdict.valid),
    reason: draft.data.reason ?? "",
    ...(verdict.valid
      ? {}
      : {
          error: {
            code: verdict.error_code ?? "VALIDATION",
            message: verdict.error_message ?? "This request cannot be submitted.",
          },
        }),
    ...(verdict.conflicts?.length ? { conflicts: verdict.conflicts } : {}),
  };

  return {
    kind: "preview",
    card,
    // The prose is a description of the card, never a claim that anything was
    // submitted. Submission is a separate, explicit act by the employee.
    reply: verdict.valid
      ? `Here is what ${TYPE_LABEL[draft.data.leave_type]} leave for ${draft.data.start_date} to ${draft.data.end_date} looks like. Nothing has been submitted yet — check the card and press submit if it is right.`
      : verdict.error_message ?? "That request cannot be submitted as it stands.",
  };
}
