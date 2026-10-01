import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/server/api/errors";
import { parseJson, readJson } from "@/server/api/parse";
import { requireHrOrAdmin } from "@/server/api/session";
import { isLlmConfigured } from "@/server/ai/llm";
import { HR_QUERY_EXAMPLES, runHrQuery } from "@/server/ai/hr-query";
import type { ToolContext } from "@/server/ai/tools.employee";

/** A question is a sentence or two, not a document. */
const MAX_QUESTION_CHARS = 500;

const bodySchema = z.object({
  question: z
    .string()
    .trim()
    .min(3, "Ask a question about leave, balances, approvals or availability.")
    .max(MAX_QUESTION_CHARS, "Keep the question a little shorter."),
});

/**
 * POST /api/ai/hr-query
 *
 * HR only. The role gate runs FIRST, before `isLlmConfigured` and long before the
 * model, so a manager or employee calling this gets FORBIDDEN without a single
 * token being spent and without the catalog being revealed to them.
 *
 * The database repeats the same check inside every `q_*` function. Two layers is
 * not redundancy for its own sake: this one keeps an unauthorised request away
 * from the model, and the other still holds if someone reaches the functions
 * directly over PostgREST.
 *
 * Like the copilot, an unavailable model is a readable sentence rather than an
 * error, because the rest of the app does not depend on it.
 */
export async function POST(request: NextRequest) {
  try {
    // Before anything else. An unauthorised caller must not learn whether the
    // assistant is even configured.
    const session = await requireHrOrAdmin();

    const body = parseJson(bodySchema, await readJson(request));

    if (!isLlmConfigured()) {
      return NextResponse.json({
        data: {
          type: "hr_query_unsupported",
          message:
            "The assistant is not configured on this server, so I can't answer just now. " +
            "The rest of the dashboard is unaffected.",
          examples: HR_QUERY_EXAMPLES,
        },
        meta: { available: false, reason: "AI_NOT_CONFIGURED" },
      });
    }

    const context: ToolContext = {
      supabase: session.supabase,
      employee: session.employee,
    };

    const event = await runHrQuery(context, body.question);

    if (event.type === "error") {
      return NextResponse.json({
        data: {
          type: "hr_query_unsupported",
          message: event.message,
          examples: HR_QUERY_EXAMPLES,
        },
        meta: { available: false, reason: event.code },
      });
    }

    return NextResponse.json({ data: event.data, meta: { available: true } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
