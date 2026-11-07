"use client";

import { FailurePanel } from "@/components/shell/failure-panel";

import "./globals.css";

/**
 * The last resort: the root layout itself failed.
 *
 * It REPLACES the root layout, which is why it has to supply `<html>` and
 * `<body>` of its own — and why it imports the stylesheet directly, since
 * nothing above it did.
 *
 * No theme script runs here, so this renders in the dark default rather than
 * whichever theme the reader chose. That is the correct trade: a page that
 * renders in the wrong colours is readable, and a page that renders unstyled
 * HTML because it tried to be clever is not.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en-ZA" className="h-full">
      <body className="min-h-full bg-canvas text-ink-950 antialiased">
        <FailurePanel
          error={error}
          reset={reset}
          title="The app could not start"
        />
      </body>
    </html>
  );
}
