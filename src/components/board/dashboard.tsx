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
  mapNotice,
}: {
  rows: BoardRow[];
  mapped: MappedShipment[];
  clock: JourneyClock;
  styleBase: string | null;
  /**
   * Set when the checkpoint read failed because the database is behind.
   *
   * It is rendered rather than swallowed on purpose. Degrading the map to
   * "no pins" without saying why is indistinguishable from "nothing has been
   * confirmed yet" — and this product's whole claim is that what it shows can
   * be believed. A quiet empty map is the one outcome worse than an error.
   */
  mapNotice?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-list lg:overflow-hidden">
      {mapNotice ? (
        <p
          role="status"
          className="rounded-control bg-late-bg px-3 py-2 text-small whitespace-pre-wrap text-late"
        >
          {mapNotice}
        </p>
      ) : null}

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
    </div>
  );
}
