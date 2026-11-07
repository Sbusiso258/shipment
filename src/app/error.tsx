"use client";

import { FailurePanel } from "@/components/shell/failure-panel";

/**
 * The boundary that catches the most.
 *
 * An `error.tsx` catches failures in its segment's CHILDREN, never in its own
 * layout — so `(app)/error.tsx` cannot catch `(app)/layout.tsx`, and that
 * layout is the single likeliest thing to throw: it calls `requireSession`
 * and loads the whole board before any page renders. This one, at the root,
 * is what stands behind it.
 *
 * It renders inside the root layout, so the fonts and the theme are already
 * there. `global-error.tsx` is the one that is not so lucky.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <FailurePanel error={error} reset={reset} />;
}
