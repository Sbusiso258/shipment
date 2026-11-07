import { cn } from "@/lib/utils";

/**
 * The logo.
 *
 * Inline SVG rather than an image file: it is six paths, it must take its
 * colour from the theme, and a request for a logo is a request the page can
 * do without.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <svg
        viewBox="0 0 32 32"
        className="size-8 shrink-0"
        role="img"
        aria-label="Shipment Oversight"
      >
        {/* A hexagon — the container shape, and the one geometric form that
            reads as freight rather than as a generic app icon. */}
        <path
          d="M16 2.5 28 9.25v13.5L16 29.5 4 22.75V9.25Z"
          fill="var(--marine-100)"
          stroke="var(--marine-500)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        {/* An open box inside it, drawn as three faces. */}
        <path
          d="M16 11 22 14.25v6.5L16 24l-6-3.25v-6.5Z"
          fill="none"
          stroke="var(--marine-200)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M10 14.25 16 17.5l6-3.25M16 17.5V24"
          fill="none"
          stroke="var(--marine-200)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>

      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-body font-semibold tracking-tight text-ink-950">
          Shipment Oversight
        </span>
        <span className="truncate text-micro uppercase tracking-widest text-ink-400">
          Oversight · Track · Coordinate
        </span>
      </span>
    </span>
  );
}
