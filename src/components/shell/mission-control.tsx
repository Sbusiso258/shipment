import { Package } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The two-column grid: shipments on the left, activity on the right.
 *
 * Both columns scroll independently and fill whatever space the shell gives
 * them. The height comes from the FLEX CHAIN, not from
 * `calc(100dvh - var(--header-h))`: that arithmetic has to know about every
 * element between the viewport and here, and it was already wrong by the
 * height of one banner. A `flex-1` child of a fixed-height column is right by
 * construction, and the collapsing header works without being counted.
 *
 * EVERY SCROLLING GRID CHILD CARRIES `min-h-0`. Without it the child's content
 * establishes the track height, the track grows to fit, and the inner
 * `overflow-y-auto` never engages — the page scrolls as one instead, which
 * looks like the layout simply does not work. It is the most common way this
 * particular layout breaks.
 */
export function MissionControl({
  left,
  right,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-auto grid w-full max-w-[110rem] gap-list px-4 py-4",
        // Below lg the page scrolls normally: two independently scrolling
        // panes on a phone is a worse experience than one long page.
        "lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:overflow-hidden"
      )}
    >
      <div className="flex min-h-0 flex-col gap-list">{left}</div>
      <div className="flex min-h-0 flex-col gap-list">{right}</div>
    </div>
  );
}

export function ShipmentsPanelHeader({
  count,
  children,
}: {
  count: number;
  /** Search and filter controls. */
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-ink-200 p-panel">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-panel bg-marine-100 text-marine-200">
        <Package aria-hidden className="size-5" />
      </span>

      <div className="min-w-0 flex-1">
        <h1 className="text-lead font-medium text-ink-950">Shipments</h1>
        <p className="truncate text-small text-ink-400">
          {count === 0
            ? "Nothing recorded yet"
            : `Tracking ${count} shipment${count === 1 ? "" : "s"}`}
        </p>
      </div>

      {children}
    </header>
  );
}
