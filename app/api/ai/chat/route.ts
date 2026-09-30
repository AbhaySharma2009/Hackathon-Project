import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/server/api/errors";import { parseJson, readJson } from "@/server/api/parse";
import { requireSession } from "@/server/api/session";
import { runCopilotTurn } from "@/server/ai";
import { isLlmConfigured } from "@/server/ai/llm";

/** A turn is a short exchange, not a transcript. */
const MAX_MESSAGE_CHARS = 2_000;
const MAX_HISTORY = 20;

const chatSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, "Say something first.")
    .max(MAX_MESSAGE_CHARS, "Keep it a little shorter."),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(MAX_MESSAGE_CHARS),
      }),
    )
    .max(MAX_HISTORY)
    .default([]),
});

/**
 * The assistant being down is not a failed request.
 *
 * The app is fully usable without the copilot, so an unavailable model answers
 * 200 with `available: false` and a sentence the user can read — the same shape
 * as a missing key. The client renders the message and shows its offline badge;
 * there is no error to recover from and nothing for the user to fix.
 */
function unavailable(reason: string, message: string) {
  return NextResponse.json({
    data: { message, card: null, tools_used: [] },
    meta: { available: false, reason },
  });
}

/**
 * POST /api/ai/chat
 *
 * The copilot's only endpoint. The flow is fixed and has no bypass:
 *
 *   session -> employee + role resolved from the database
 *          -> LLM given a tool whitelist and nothing else (rule 5)
 *          -> each tool call executed as the signed-in employee, so RLS applies
 *          -> result back to the model, or rendered as a structured card
 *
 * There is no `employee_id` parameter anywhere in this path. The employee comes
 * from the auth cookie and the tools are bound to that one session, so a crafted
 * prompt cannot redirect a query at somebody else — and if the model tried, the
 * tool schema has nowhere to put the request and the RLS policy would refuse it.
 *
 * The LLM key is server-only and lives in `llm.ts`. This route never sees it.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    const body = parseJson(chatSchema, await readJson(request));

    if (!isLlmConfigured()) {
      return unavailable(
        "AI_NOT_CONFIGURED",
        "The assistant is not configured on this server, so I can't answer just now. Everything else in the app still works — you can book leave from the My Leaves page.",
      );
    }

    const event = await runCopilotTurn(
      { supabase: session.supabase, employee: session.employee },
      body.history,
      body.message,
    );

    if (event.type === "error") {
      return unavailable(event.code, event.message);
    }

    return NextResponse.json({ data: event.data, meta: { available: true } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
