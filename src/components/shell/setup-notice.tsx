/**
 * Shown on the login page when Supabase is not configured.
 *
 * A fresh clone has no `.env.local`, and the alternative to this panel is a
 * stack trace from the first query. Setup instructions are a better first
 * screen than a crash, and they are the difference between "this is broken" and
 * "this needs two values".
 */
export function SetupNotice() {
  return (
    <div className="rounded-panel border border-late/30 bg-late-bg p-5">
      <h2 className="text-lead font-medium text-ink-950">
        Supabase is not configured
      </h2>
      <p className="mt-2 text-ink-800">
        The app cannot sign anyone in until it knows which project to talk to.
      </p>

      <ol className="mt-4 flex list-decimal flex-col gap-2 pl-5 text-ink-800">
        <li>
          Copy <code className="font-code text-small">.env.example</code> to{" "}
          <code className="font-code text-small">.env.local</code>.
        </li>
        <li>
          Fill in{" "}
          <code className="font-code text-small">NEXT_PUBLIC_SUPABASE_URL</code>{" "}
          and{" "}
          <code className="font-code text-small">
            NEXT_PUBLIC_SUPABASE_ANON_KEY
          </code>{" "}
          from your Supabase project under <strong>Settings → API</strong>.
        </li>
        <li>Restart the dev server.</li>
      </ol>

      <p className="mt-4 text-small text-ink-600">
        The anon key is safe to expose — it grants nothing on its own, and every
        access rule is enforced by row-level security in the database. There is
        no service-role key in this project and there must never be one.
      </p>
    </div>
  );
}
