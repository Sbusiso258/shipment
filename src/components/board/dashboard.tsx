"use client";

import { useState } from "react";

import { ShipmentsPanel } from "@/components/board/shipments-panel";
import { TrackingMap, type MappedShipment } from "@/components/board/tracking-map";
import type { BoardRow } from "@/lib/board";
import type { JourneyClock } from "@/lib/journey";

/**
 * The two panels, and the one thing they share.
 *
 * Selection is lifted to here and nowhere higher: the map and the list both
 * need it, nothing else does, and putting it in the URL would mean a server
 * round trip every time somebody glances at a different load.
 */
export function Dashboard({
  rows,
  mapped,
  clock,
  styleBase,
}: {
  rows: BoardRow[];
  mapped: MappedShipment[];
  clock: JourneyClock;
  styleBase: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="grid min-h-0 flex-1 gap-list lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)] lg:overflow-hidden">
      <TrackingMap
        shipments={mapped}
        selectedId={selectedId}
        onSelect={setSelectedId}
        styleBase={styleBase}
      />
      <ShipmentsPanel
        rows={rows}
        clock={clock}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
    </div>
  );
}
