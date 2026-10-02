import "server-only";

import { z } from "zod";
import { ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES, PHOTO_BUCKET } from "@/shared/profile-photos";

export { PHOTO_BUCKET, MAX_PHOTO_BYTES, ALLOWED_PHOTO_TYPES };

/**
 * Server-side upload validation.
 *
 * The client runs the same rules as a pre-flight check so an obvious mistake is
 * reported instantly, but this is the copy that actually decides. `type` here is
 * still only a claim from the browser — the route sniffs the file's magic bytes
 * before anything is stored.
 */
export const photoValidationSchema = z.object({
  type: z
    .string()
    .refine(
      (type) => (ALLOWED_PHOTO_TYPES as readonly string[]).includes(type),
      "Use a PNG, JPEG or WebP image.",
    ),
  size: z
    .number()
    .int()
    .positive("That file is empty.")
    .max(MAX_PHOTO_BYTES, "Images must be 2 MB or smaller."),
});