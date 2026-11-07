/**
 * How a read from Supabase gives up.
 *
 * Shared rather than copied into each service, because the interesting part is
 * not the throw — it is the ONE case below that would otherwise be diagnosed
 * from scratch every time it happens.
 */

/**
 * PostgREST's code for "that table is not in my schema cache". It means one of
 * two things, and they are told apart by whether the table exists in Postgres
 * at all:
 *
 *   The migration has not been applied. The schema in `supabase/migrations/`
 *   is ahead of the database. This is the common one, and it happens the first
 *   time a page touches a table that only exists in the repository.
 *
 *   The migration HAS been applied and PostgREST has not noticed. Its cache
 *   reloads on a `pgrst` notification; a `create table` in the SQL editor
 *   normally triggers one, but a transaction that commits while the server is
 *   busy can be missed.
 *
 * The error says both, because the fix differs and the message is the only
 * thing the person staring at a 500 has to go on.
 */
const SCHEMA_CACHE = "PGRST205";

/**
 * Postgres' own answers when the code asks for something the database has not
 * got: `42703` undefined_column, `42P01` undefined_table.
 *
 * These are separate from `PGRST205` and were not caught, which made the
 * difference between a MISSING TABLE and a MISSING COLUMN the difference
 * between a page that says what to do and a page that just says what broke.
 * Reading a column added by an unapplied migration is the commoner of the two
 * — a new table usually arrives with the code that reads it, whereas a new
 * column gets read by code shipped ahead of the migration.
 */
const UNDEFINED_COLUMN = "42703";
const UNDEFINED_TABLE = "42P01";

export interface PostgrestLikeError {
  message: string;
  code?: string;
}

/**
 * Thrown when the database is behind the schema in `supabase/migrations/`.
 *
 * A distinct type so ONE caller can choose to degrade instead of dying: the
 * shipment page renders the journey and says which migration its admin panels
 * are waiting on, rather than taking the whole page down over a feature that
 * is not the point of the screen.
 *
 * It still throws. `AGENTS.md` says a missing table fails loudly, and this is
 * loud — what the type adds is the ability to be loud in the right PLACE,
 * which is a notice on the panel rather than a stack trace over the journey.
 * Catching it anywhere means showing the reader that something is missing.
 */
export class SchemaBehindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaBehindError";
  }
}

/**
 * Never interpolate a ROW into an error: it can reach somebody who was not
 * permitted to read it. A table NAME is different — it is in the repository,
 * it is in the error PostgREST already returned, and without it the reader
 * cannot tell which migration is missing.
 */
export function describeFailure(what: string, error: PostgrestLikeError): string {
  if (isSchemaBehind(error)) {
    return (
      `Failed to ${what}: the database is missing something this code needs ` +
      `(${error.message}).\n\n` +
      `The database is behind the schema in supabase/migrations/. Apply the ` +
      `missing migration:\n` +
      `  bash supabase/bundle-migration.sh <number>\n` +
      `  npm run verify:upgrade <number>\n` +
      `then paste supabase/apply-<number>.sql into the Supabase SQL editor.\n\n` +
      `If it HAS been applied, PostgREST is holding a stale cache — run ` +
      `  notify pgrst, 'reload schema';\n` +
      `in the SQL editor, or restart the project under Settings → General.`
    );
  }

  return `Failed to ${what}: ${error.message}`;
}

/** True when PostgREST is reporting something the migrations have not created. */
export function isSchemaBehind(error: PostgrestLikeError): boolean {
  if (
    error.code === SCHEMA_CACHE ||
    error.code === UNDEFINED_COLUMN ||
    error.code === UNDEFINED_TABLE
  ) {
    return true;
  }
  // PostgREST does not always forward the code, so the message shape is the
  // fallback. Deliberately narrow: `does not exist` on its own also covers a
  // missing ROW, which is not a schema problem and must not be reported as
  // one.
  return (
    /schema cache/i.test(error.message) ||
    /\b(column|relation|table)\b[^\n]*does not exist/i.test(error.message)
  );
}

/** Throws. Returns `never`, so a caller needs no `return` after it. */
export function fail(what: string, error: PostgrestLikeError | string): never {
  const normalised = typeof error === "string" ? { message: error } : error;
  const message = describeFailure(what, normalised);

  if (isSchemaBehind(normalised)) throw new SchemaBehindError(message);
  throw new Error(message);
}
