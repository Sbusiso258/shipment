import type { JourneyCheckpoint } from "@/types/domain";

/**
 * Where each shipment actually is.
 *
 * THE ONLY HONEST ANSWER IS THE LAST PLACE IT WAS CONFIRMED. `AGENTS.md`
 * forbids interpolating a position outright: a dot between two stages is a
 * GPS fix nobody reported, and the day a customer realises the dot was a
 * guess, every other number on the page becomes a guess too. So this picks
 * the latest CLEARED checkpoint that has coordinates, and the interface says
 * "last seen" rather than "is".
 *
 * Pure, and in `lib` rather than a component, because it is a judgement about
 * what the data means. There is no clock here and no query — the caller
 * passes the checkpoints in.
 */

export interface ShipmentPosition {
  shipmentId: string;
  checkpointId: string;
  label: string;
  latitude: number;
  longitude: number;
  /** When it was confirmed there. Null never happens for a cleared stage. */
  confirmedAt: string | null;
}

/**
 * One position per shipment, from a flat list of checkpoints.
 *
 * Takes the checkpoint with the HIGHEST `sequenceNo` among those confirmed —
 * not the most recent `actualAt`. A stage confirmed late, after a later one
 * was already logged, would otherwise drag the pin backwards along the route.
 * Sequence is the route's own order and is what "furthest along" means.
 */
export function lastConfirmedPositions(
  checkpoints: JourneyCheckpoint[]
): Map<string, ShipmentPosition> {
  const best = new Map<string, { position: ShipmentPosition; sequence: number }>();

  for (const checkpoint of checkpoints) {
    if (checkpoint.actualAt === null) continue;
    if (checkpoint.latitude === null || checkpoint.longitude === null) continue;

    const existing = best.get(checkpoint.shipmentId);
    if (existing && existing.sequence >= checkpoint.sequenceNo) continue;

    best.set(checkpoint.shipmentId, {
      sequence: checkpoint.sequenceNo,
      position: {
        shipmentId: checkpoint.shipmentId,
        checkpointId: checkpoint.id,
        label: checkpoint.label,
        latitude: checkpoint.latitude,
        longitude: checkpoint.longitude,
        confirmedAt: checkpoint.actualAt,
      },
    });
  }

  return new Map(
    [...best].map(([shipmentId, entry]) => [shipmentId, entry.position])
  );
}
