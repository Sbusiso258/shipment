"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { readSupabaseEnv } from "./env";

/**
 * The browser Supabase client.
 *
 * A single shared instance: each `createBrowserClient` call registers its own
 * auth listener and its own realtime socket, so creating one per component
 * would leak sockets on every navigation.
 */

let client: SupabaseClient | null = null;

export function supabaseBrowser(): SupabaseClient {
  if (client) return client;

  const { url, anonKey } = readSupabaseEnv();
  client = createBrowserClient(url, anonKey);
  return client;
}
