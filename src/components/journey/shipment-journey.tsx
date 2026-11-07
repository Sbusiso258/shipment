"use client";

import { useRouter, useSearchParams } from "next/navigation";

import type { CheckpointState } from "@/lib/journey";
import type { JourneyCheckpoint } from "@/types/domain";

import { CheckpointSpine } from "./checkpoint-spine";
import { RouteMap, type RoutePoint } from "./route-map";

/**
 * Keeps the spine and the map looking at the same thing.
 *
 * Selection lives in the URL, read DURING RENDER. Three reasons: a selected
 * stage becomes linkable, it survives a refresh, and the back button works.
 * Mirroring the URL into `useState` inside an effect would render the wrong
 * selection for one frame and then cascade a second render — the house rule
 * is that navigation-derived state is synced during render, never in an
 * effect.
 */
export function ShipmentJourney({
  checkpoints,
  states,
  timeZone,
  mapStyleUrl,
}: {
  checkpoints: JourneyCheckpoint[];
  /** Plain object rather than a Map: this crosses the server boundary. */
  states: Record<string, CheckpointState>;
  timeZone: string;
  mapStyleUrl: string | null;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();

  const selectedId = searchParams.get("stage");

  function select(id: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (next.get("stage") === id) next.delete("stage");
    else next.set("stage", id);
    router.replace(`?${next.toString()}`, { scroll: false });
  }

  const stateMap = new Map(Object.entries(states)) as Map<string, CheckpointState>;

  // Only checkpoints with a known position can be drawn. A route with gaps is
  // better than a route with invented points.
  const points: RoutePoint[] = checkpoints
    .filter(
      (cp): cp is JourneyCheckpoint & { latitude: number; longitude: number } =>
        cp.latitude !== null && cp.longitude !== null
    )
    .sort((a, b) => a.sequenceNo - b.sequenceNo)
    .map((cp) => ({
      id: cp.id,
      label: cp.label,
      latitude: cp.latitude,
      longitude: cp.longitude,
      state: stateMap.get(cp.id) ?? "pending",
    }));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="rounded-panel border border-ink-200 bg-paper p-4 shadow-panel">
        <CheckpointSpine
          checkpoints={checkpoints}
          states={stateMap}
          selectedId={selectedId}
          onSelect={select}
          timeZone={timeZone}
        />
      </div>

      <RouteMap
        points={points}
        selectedId={selectedId}
        onSelect={select}
        styleUrl={mapStyleUrl}
      />
    </div>
  );
}
