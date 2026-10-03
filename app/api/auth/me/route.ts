import { NextResponse } from "next/server";
import { toErrorResponse } from "@/server/api/errors";
import { requireSession } from "@/server/api/session";

export async function GET() {
  try {
    const { employee } = await requireSession();
    return NextResponse.json({ data: employee });
  } catch (error) {
    return toErrorResponse(error);
  }
}