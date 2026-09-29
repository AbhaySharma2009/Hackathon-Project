import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, toErrorResponse } from "@/server/api/errors";
import { parseJson, readJson } from "@/server/api/parse";
import { requireSession } from "@/server/api/session";

type Context = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const markReadSchema = z.object({ is_read: z.boolean() });

/**
 * PATCH /api/alerts/[id] — mark one alert read or unread.
 *
 * RLS on `alerts_update_own` is the gate: a caller can only touch an org-wide
 * alert, one scoped to them, or anything at all if they are HR. Nothing here
 * re-derives that, so a forged id simply updates zero rows.
 */
export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    if (!UUID_RE.test(id)) throw new ApiError("VALIDATION", "Invalid alert id.");

    const { supabase } = await requireSession();
    const body = parseJson(markReadSchema, await readJson(request));

    const { data, error } = await supabase
      .from("alerts")
      .update({ is_read: body.is_read })
      .eq("id", id)
      .select("id, is_read")
      .maybeSingle();

    if (error) throw error;
    // Zero rows means either the alert does not exist or RLS hid it. Telling the
    // two apart would leak the existence of someone else's alert.
    if (!data) throw new ApiError("NOT_FOUND", "Alert not found.");

    return NextResponse.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
