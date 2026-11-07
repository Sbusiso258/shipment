/**
 * Supabase connection settings, read from the environment in exactly one place.
 *
 * Only the URL and the publishable (anon) key are ever used. That key grants no
 * privileges by itself — every rule about who may read or write a row is
 * enforced by Row Level Security in the database. There is no service-role key
 * anywhere in this project, so nothing privileged can leak into the bundle.
 *
 * In a multi-tenant product that distinction is not academic. A service-role
 * key bypasses RLS entirely, so one leaking into the client bundle would expose
 * every organisation's shipments to every visitor at once.
 */

export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

const SETUP_HINT =
  "Supabase is not configured. Copy .env.example to .env.local, fill in " +
  "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY from your " +
  "Supabase project's API settings, then restart the dev server.";

export function readSupabaseEnv(): SupabaseEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) throw new Error(SETUP_HINT);

  return { url, anonKey };
}

/**
 * Whether Supabase is configured at all.
 *
 * The app is useless without a database, but crashing with a stack trace on a
 * fresh clone is a poor first impression — the login page uses this to render
 * setup instructions instead.
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}
