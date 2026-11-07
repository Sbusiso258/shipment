"use client";

import { useDensity, type Density } from "@/hooks/use-density";
import { useMounted } from "@/hooks/use-mounted";
import { cn } from "@/lib/utils";

const OPTIONS: { value: Density; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

/**
 * How much fits on screen.
 *
 * `radiogroup` semantics, not a row of buttons: exactly one is selected at a
 * time and the others are alternatives, which is what a screen reader needs
 * to hear. A group of plain buttons would announce three unrelated actions.
 */
export function DensityControl({ className }: { className?: string }) {
  const mounted = useMounted();
  const { density, setDensity } = useDensity();

  return (
    <div
      role="radiogroup"
      aria-label="Information density"
      className={cn(
        "flex items-center gap-0.5 rounded-control border border-ink-200 bg-paper p-0.5",
        className
      )}
    >
      {OPTIONS.map((option) => {
        // Before hydration the stored preference is unknown, so nothing is
        // marked selected rather than medium being marked wrongly.
        const selected = mounted && density === option.value;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setDensity(option.value)}
            className={cn(
              "rounded-[0.25rem] px-2 py-1 text-micro transition-colors",
              selected
                ? "bg-marine-700 text-marine-on"
                : "text-ink-600 hover:bg-ink-100 hover:text-ink-950"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
