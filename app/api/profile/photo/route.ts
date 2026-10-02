import type { NextRequest } from "next/server";
import { ApiError, toErrorResponse } from "@/server/api/errors";
import { requireSession } from "@/server/api/session";
import { createAdminClient } from "@/server/supabase/admin-core";
import { PHOTO_BUCKET } from "@/shared/profile-photos";
import { photoValidationSchema } from "@/server/profile-photos";

/**
 * Avatar upload and removal.
 *
 * A separate route rather than extra methods on `/api/profile`, so that
 * `/api/profile` stays exactly "my details" — one resource, one route — and the
 * multipart body is handled somewhere that only ever expects one.
 *
 * The file lives in Supabase Storage; the `employees` row only holds its public
 * URL, which is what `update_employee_photo` guards.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The RPCs answer in "KIND: message"; the API answers in status codes.
 * `ApiError` rather than a plain `Error`, because `toErrorResponse` maps only
 * `ApiError` and turns anything else into an opaque 500.
 */
function rethrow(error: { message: string }): never {
  const [kind, ...rest] = error.message.split(": ");
  const message = rest.join(": ") || error.message;

  if (kind === "FORBIDDEN") throw new ApiError("FORBIDDEN", message);
  if (kind === "VALIDATION") throw new ApiError("VALIDATION", message);
  if (kind === "NOT_FOUND") throw new ApiError("NOT_FOUND", message);
  if (kind === "UNAUTHENTICATED") throw new ApiError("FORBIDDEN", "You must be signed in.");
  throw error;
}

/**
 * POST /api/profile/photo — upload or replace the caller's avatar.
 *
 * The file is validated on its declared type, its byte count, and its magic
 * bytes, then stored as `<employee id>/avatar.<ext>`. Writing in place is what
 * makes "replace" work: the path never changes, so only the cache-buster moves.
 */
export async function POST(request: NextRequest) {
  try {
    const { employee, supabase } = await requireSession();

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");

    if (!(file instanceof File)) {
      throw new ApiError("VALIDATION", "Choose an image to upload.");
    }

    const problem = photoValidationSchema.safeParse({ type: file.type, size: file.size });
    if (!problem.success) {
      throw new ApiError("VALIDATION", problem.error.issues[0].message);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    // `file.type` is a client claim. The magic bytes are the fact, and the
    // extension is taken from them so a .txt named .png cannot land in the
    // bucket wearing an image content type.
    const sniffed = sniffImage(bytes);
    if (!sniffed) {
      throw new ApiError("VALIDATION", "That file is not a PNG, JPEG or WebP image.");
    }

    const admin = createAdminClient();
    const path = `${employee.id}/avatar.${sniffed}`;

    const { error: uploadError } = await admin.storage
      .from(PHOTO_BUCKET)
      .upload(path, bytes, { contentType: `image/${sniffed}`, upsert: true });

    if (uploadError) throw uploadError;

    const { data: url } = admin.storage.from(PHOTO_BUCKET).getPublicUrl(path);

    const { error: linkError } = await supabase.rpc("update_employee_photo", {
      p_actor: employee.id,
      p_employee_id: employee.id,
      p_photo: url.publicUrl,
    });

    if (linkError) rethrow(linkError);

    return Response.json({ data: { photo: url.publicUrl } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** DELETE /api/profile/photo — remove the avatar and fall back to initials. */
export async function DELETE() {
  try {
    const { employee, supabase } = await requireSession();
    const admin = createAdminClient();

    const { data: files } = await admin.storage
      .from(PHOTO_BUCKET)
      .list(employee.id, { limit: 50 });

    const stored = (files ?? []).filter((f) => f.name?.startsWith("avatar."));
    if (stored.length > 0) {
      await admin.storage
        .from(PHOTO_BUCKET)
        .remove(stored.map((f) => `${employee.id}/${f.name}`));
    }

    const { error } = await supabase.rpc("update_employee_photo", {
      p_actor: employee.id,
      p_employee_id: employee.id,
      p_photo: null,
    });

    if (error) rethrow(error);

    return Response.json({ data: { photo: null } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Identify an image from its magic bytes, returning the extension that matches
 * the actual content.
 */
function sniffImage(bytes: Uint8Array): "png" | "jpeg" | "webp" | null {
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return "png";
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length > 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}