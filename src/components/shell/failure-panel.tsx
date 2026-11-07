"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * What a failure looks like.
 *
 * THE POINT IS LEGIBILITY, NOT RECOVERY. Nothing here swallows an error or
 * renders an empty page in its place — `AGENTS.md` is explicit that a missing
 * table must fail loudly, because the alternative, a page that quietly shows
 * nothing, is indistinguishable from a tenant with no data. This boundary
 * keeps the failure and makes it readable.
 *
 * THE MESSAGE IS THE SERVICE'S OWN. `describeFailure` in
 * `src/services/fail.ts` already turns PostgREST's `PGRST205` into a
 * paragraph naming the missing table and the command that fixes it. Replacing
 * that with "Something went wrong" would throw away the only useful thing on
 * the screen.
 *
 * IT IS SAFE TO SHOW. The services never interpolate a row into an error —
 * an error can reach somebody who was not permitted to read what caused it —
 * so what arrives here is a table name, a constraint name or a sentence.
 *
 * WHAT YOU SEE DEPENDS ON WHERE YOU ARE. In development Next hands the real
 * message through. In a production build it replaces server-side messages
 * with a generic one and keeps only the digest, which is why the digest is
 * always rendered: it is the thing that ties this screen to a line in the
 * server log.
 */
export function FailurePanel({
  error,
  reset,
  title = "This page could not load",
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  title?: string;
}) {
  const message = error.message?.trim();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-10">
      <header>
        <h1 className="text-title font-semibold text-ink-950">{title}</h1>
        <p className="mt-1 text-ink-600">
          Nothing was changed. The reason is below, in full.
        </p>
      </header>

      {message ? (
        <div
          role="alert"
          className="rounded-panel border border-exception/30 bg-exception-bg p-panel"
        >
          {/* `whitespace-pre-wrap`, because describeFailure writes paragraphs
              and a command to run. Collapsing them into one line would make
              the one actionable part unreadable. */}
          <p className="whitespace-pre-wrap font-code text-small text-exception">
            {message}
          </p>
        </div>
      ) : null}

      {error.digest ? (
        <p className="text-micro text-ink-400">
          Reference <span className="font-code">{error.digest}</span> — the
          server log carries the full detail under this id.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {reset ? (
          <Button type="button" onClick={reset}>
            Try again
          </Button>
        ) : null}
        <Button asChild variant="secondary">
          <Link href="/">Back to the board</Link>
        </Button>
      </div>
    </main>
  );
}
