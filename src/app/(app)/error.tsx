"use client";

import { FailurePanel } from "@/components/shell/failure-panel";

/**
 * A failure inside the dashboard, with the shell kept.
 *
 * This replaces the PAGE and leaves `(app)/layout.tsx` standing, so the
 * header, the status cluster and the navigation survive — somebody who hits a
 * broken shipment can still get to the board, the places or their team
 * without using the back button.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <FailurePanel error={error} reset={reset} />;
}
