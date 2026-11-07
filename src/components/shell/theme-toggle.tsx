"use client";

import { Moon, Sun } from "lucide-react";

import { useMounted } from "@/hooks/use-mounted";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

/**
 * Switches between the dark default and the light alternative.
 *
 * Renders a same-sized placeholder until mounted. The applied theme comes
 * from a class the pre-paint script set, which the server render knows
 * nothing about — so an icon chosen on the server could contradict the page
 * for one frame, and a missing icon would shift the header.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const mounted = useMounted();
  const { theme, toggle } = useTheme();

  const base = cn(
    "inline-flex size-9 items-center justify-center rounded-control",
    "text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-950",
    className
  );

  if (!mounted) {
    return <span aria-hidden className={base} />;
  }

  const goingTo = theme === "light" ? "dark" : "light";

  return (
    <button
      type="button"
      onClick={toggle}
      className={base}
      // The name says what pressing it DOES, not what the current state is —
      // "Light theme" on a button that switches to dark is the usual way this
      // control is made confusing for a screen reader.
      aria-label={`Switch to ${goingTo} theme`}
      title={`Switch to ${goingTo} theme`}
    >
      {theme === "light" ? (
        <Moon aria-hidden className="size-4" />
      ) : (
        <Sun aria-hidden className="size-4" />
      )}
    </button>
  );
}
