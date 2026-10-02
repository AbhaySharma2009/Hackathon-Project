/**
 * Avatar constants shared by the browser and the server.
 *
 * This module is deliberately isomorphic. The upload rules and the bucket name
 * are server concerns and live in `@/server/profile-photos`, but the client needs
 * the same size limit for its own pre-flight check and the same initials
 * fallback for rendering — and a "use client" component cannot import a module
 * marked `server-only`.
 *
 * Having one definition means the limit shown to the user is the limit the server
 * enforces, rather than two numbers that can drift apart.
 */

/** The one bucket avatars live in. Created by migration 0017. */
export const PHOTO_BUCKET = "profile-photos";

/**
 * 2 MB is generous for a profile picture and small enough that the bucket cannot
 * be filled by a handful of uploads.
 */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

export const ALLOWED_PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/** Bytes per extension, for the `accept` filter. */
export const PHOTO_ACCEPT = ALLOWED_PHOTO_TYPES.join(",");

/** Placeholder shown when someone has not uploaded a photo. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/** The object path an avatar is written to. */
export function photoPath(employeeId: string, extension: string): string {
  return `${employeeId}/avatar.${extension}`;
}