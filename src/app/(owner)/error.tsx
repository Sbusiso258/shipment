"use client";

import { FailurePanel } from "@/components/shell/failure-panel";

/**
 * A failure in the platform owner's area, with its own header kept.
 *
 * Separate from the dashboard's boundary because the two have different
 * shells, and because the owner's screens are the ones used to REPAIR a
 * broken database — sending them to the board would be sending them away
 * from the fix.
 */
export default function OwnerError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <FailurePanel
      error={error}
      reset={reset}
      title="This admin screen could not load"
    />
  );
}
