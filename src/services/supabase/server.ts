import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { readSupabaseEnv } from "./env";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * Not cached across requests: it is bound to one request's cookies, and sharing
 * it would hand one request another's session — which in this product means
 * handing one logistics business another's shipments.
 */
export async function supabaseServer(): Promise<SupabaseClient> {
  // Awaited before anything else, including the env read that can throw.
  // `cookies()` is a Dynamic API: touching it is what tells Next this route
  // depends on the request and must not be statically prerendered. Throwing
  // first would abort the build instead, since every page under (app) is
  // per-user by definition and has nothing to prerender.
  const cookieStore = await cookies();
  const { url, anonKey } = readSupabaseEnv();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components may not write cookies. Harmless here: the proxy
          // refreshes the session on every request, so a token that could not
          // be written back will be rewritten on the next one.
        }
      },
    },
  });
}
