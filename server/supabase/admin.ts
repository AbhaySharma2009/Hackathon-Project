import "server-only";

/**
 * Server-only entry point for the service-role client.
 *
 * `server-only` makes any accidental import from a Client Component a build
 * error, which is how rule 6 (the service-role key never reaches a client
 * bundle) is enforced. The implementation lives in `admin-core.ts` so CLI
 * scripts can share it without tripping the marker.
 */
export { createAdminClient } from "./admin-core";
