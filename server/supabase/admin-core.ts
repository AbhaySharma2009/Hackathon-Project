import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/shared/types";

/**
 * Service-role client factory.
 *
 * Kept in its own module so CLI scripts (scripts/seed-auth.ts) can use it —
 * the `server-only` marker in `admin.ts` throws when imported outside a React
 * Server Component. Application code must always import `./admin` instead, so the
 * service-role key can never be pulled into a client bundle (rule 6).
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env.local.",
    );
  }

  return createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
