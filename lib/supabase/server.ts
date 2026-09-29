import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/types";

/**
 * Server client bound to the request's cookie session.
 *
 * `getAll`/`setAll` are both implemented: `setAll` runs when Supabase refreshes
 * the access token, so refreshed cookies are written back to the outgoing
 * response. The `headers` argument carries the anti-CDN-caching headers
 * Supabase requires on any response that sets auth cookies.
 *
 * A new client is created per call — never share one across requests.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
          // Supabase also passes anti-CDN-caching headers here. They are applied
          // on the response in `proxy.ts`, which owns the response object; here
          // the routes that use this client are dynamic and already uncached.
        },
      },
    },
  );
}
