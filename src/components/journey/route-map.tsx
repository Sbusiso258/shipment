"use client";

import dynamic from "next/dynamic";

import type { RoutePoint } from "./route-map-gl";
import { RouteSchematic } from "./route-schematic";

/**
 * Picks a rendering for the route.
 *
 * This wrapper is a CLIENT component on purpose: `dynamic(..., { ssr: false })`
 * is not allowed in a Server Component, and MapLibre touches `window` at
 * import time, so it cannot be server-rendered.
 */
const RouteMapGl = dynamic(() => import("./route-map-gl"), {
  ssr: false,
  loading: () => (
    <div className="aspect-[4/3] w-full animate-pulse rounded-panel border border-ink-200 bg-ink-100 lg:aspect-auto lg:h-full lg:min-h-[28rem]" />
  ),
});

export function RouteMap({
  points,
  selectedId,
  onSelect,
  styleUrl,
  connect = true,
  fitKey,
  emptyMessage = "No checkpoint on this journey has a known position yet.",
}: {
  points: RoutePoint[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Unset means no tile provider configured — fall back to the schematic. */
  styleUrl: string | null;
  /**
   * Whether to draw a line through the points in order.
   *
   * True for ONE journey, where the order is the route. False for many
   * shipments at once, where a polyline through unrelated loads would be a
   * line nobody drove.
   */
  connect?: boolean;
  /**
   * What identifies this point SET. `fitBounds` runs when it changes and at
   * no other time — without it the camera is yanked back to the full extent
   * on every refresh, and somebody reading one corner of the map loses their
   * place every few seconds.
   */
  fitKey?: string;
  emptyMessage?: string;
}) {
  if (points.length === 0) {
    return (
      <div className="flex aspect-[4/3] w-full items-center justify-center rounded-panel border border-dashed border-ink-200 p-6 text-center lg:aspect-auto lg:h-full lg:min-h-[28rem]">
        <p className="text-small text-ink-400">{emptyMessage}</p>
      </div>
    );
  }

  // The schematic is a real fallback, not a stub: it plots the same real
  // coordinates with no network dependency at all. That means the journey view
  // ships and is verifiable without a tile provider, and there is a
  // print-safe rendering for free — customers will print this page.
  if (!styleUrl) {
    return (
      <RouteSchematic points={points} selectedId={selectedId} onSelect={onSelect} />
    );
  }

  return (
    <RouteMapGl
      points={points}
      selectedId={selectedId}
      onSelect={onSelect}
      styleUrl={styleUrl}
      connect={connect}
      fitKey={fitKey ?? points.map((point) => point.id).join(",")}
    />
  );
}

export type { RoutePoint };
