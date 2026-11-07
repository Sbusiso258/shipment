"use client";

import { ChevronUp } from "lucide-react";

import { useHeaderVisibility } from "@/hooks/use-header-visibility";
import { useMounted } from "@/hooks/use-mounted";
import { cn } from "@/lib/utils";

/**
 * Collapses the top bar, to give the board the whole screen.
 *
 * Floats over the header's bottom edge so it stays reachable when the header
 * has collapsed to zero height — the header is hidden, never unmounted, so
 * keyboard focus is never stranded.
 */
export function HeaderToggle() {
  const mounted = useMounted();
  const { hidden, toggle } = useHeaderVisibility();

  return (
    <button
      type="button"
      onClick={toggle}
      // The name describes the ACTION, not the state. "Hide header" on a
      // button that shows it is the usual way this control is made confusing.
      aria-label={hidden ? "Show header" : "Hide header"}
      aria-expanded={mounted ? !hidden : undefined}
      className={cn(
        "absolute left-1/2 top-header z-20 -translate-x-1/2 -translate-y-1/2",
        "flex items-center gap-1.5 rounded-full border border-ink-200 bg-paper",
        "px-3 py-1 text-micro text-ink-600 shadow-panel",
        "transition-colors hover:border-marine-500 hover:text-ink-950"
      )}
    >
      <ChevronUp
        aria-hidden
        className={cn(
          "size-3 transition-transform",
          // Only rotate once the real state is known, so the arrow cannot
          // briefly point the wrong way.
          mounted && hidden && "rotate-180"
        )}
      />
      {mounted && hidden ? "Show header" : "Hide header"}
    </button>
  );
}
