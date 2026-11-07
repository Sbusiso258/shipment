import type { BoardRow } from "./board";
import { endOfDayIn } from "./date";
import type { JourneyCheckpoint, Shipment } from "@/types/domain";

/**
 * What the numbers mean.
 *
 * Every function here is pure and takes its reference date as an argument —
 * `src/lib` never reads the clock, because a figure computed independently on
 * server and client is a hydration mismatch, and a report that changes while
 * you look at it is not a report.
 *
 * ONE RULE GOVERNS ALL OF IT: a denominator that quietly drops rows is how a
 * 98% appears that nobody can reproduce. Every count here carries the number
 * of rows it could not judge, and the interface shows it.
 */

export interface OnTimeReport {
  /** Delivered on or before the end of the promised day, in the org's zone. */
  onTime: number;
  late: number;
  /** Delivered with no promised date — judged against nothing, so excluded. */
  unjudgeable: number;
  /** Null when nothing could be judged. Never 0% for "no data". */
  rate: number | null;
}

/**
 * Delivery against the promise.
 *
 * Judged against the END of the promised day in the organisation's timezone,
 * never against an instant. A load promised Thursday is not late at 15:00 on
 * Thursday — and comparing a promise-day to a UTC instant puts the rollover
 * at 02:00 local, which has the board shouting at ops every afternoon until
 * they stop reading it.
 */
export function onTimeReport(
  shipments: Shipment[],
  timeZone: string
): OnTimeReport {
  let onTime = 0;
  let late = 0;
  let unjudgeable = 0;

  for (const shipment of shipments) {
    if (shipment.deliveredAt === null) continue;

    if (shipment.promisedDeliveryDate === null) {
      unjudgeable += 1;
      continue;
    }

    const deadline = endOfDayIn(shipment.promisedDeliveryDate, timeZone);
    if (new Date(shipment.deliveredAt) <= deadline) onTime += 1;
    else late += 1;
  }

  const judged = onTime + late;

  return {
    onTime,
    late,
    unjudgeable,
    // Null, not zero. "No deliveries to judge" and "none were on time" are
    // different facts and must not render the same.
    rate: judged === 0 ? null : Math.round((onTime / judged) * 100),
  };
}

export interface ExceptionCount {
  kind: string;
  count: number;
}

/** What went wrong, and how often. Most frequent first. */
export function exceptionsByKind(checkpoints: JourneyCheckpoint[]): ExceptionCount[] {
  const counts = new Map<string, number>();

  for (const checkpoint of checkpoints) {
    if (checkpoint.exceptionKind === null) continue;
    counts.set(
      checkpoint.exceptionKind,
      (counts.get(checkpoint.exceptionKind) ?? 0) + 1
    );
  }

  return [...counts]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

export interface RouteVolume {
  route: string;
  count: number;
  delivered: number;
}

/** How many loads ran each corridor. Busiest first. */
export function volumeByRoute(rows: BoardRow[]): RouteVolume[] {
  const counts = new Map<string, RouteVolume>();

  for (const row of rows) {
    const route = `${row.originName} → ${row.destinationName}`;
    const existing = counts.get(route) ?? { route, count: 0, delivered: 0 };
    existing.count += 1;
    if (row.shipment.deliveredAt !== null) existing.delivered += 1;
    counts.set(route, existing);
  }

  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.route.localeCompare(b.route)
  );
}

export interface CarrierActivity {
  /** The driver's or vehicle's own label. */
  name: string;
  loads: number;
  delivered: number;
}

/**
 * Loads carried, per driver or per vehicle.
 *
 * DELIBERATELY NOT DISTANCE. Nothing records road distance, and a
 * great-circle line between two checkpoints is an estimate wearing the
 * clothes of a fact — the same objection as an interpolated position. Loads
 * and deliveries are counted, because those were actually recorded.
 */
export function activityBy(
  rows: BoardRow[],
  pick: (shipment: Shipment) => string | null
): CarrierActivity[] {
  const counts = new Map<string, CarrierActivity>();

  for (const row of rows) {
    const name = pick(row.shipment);
    if (name === null || name.trim() === "") continue;

    const key = name.trim();
    const existing = counts.get(key) ?? { name: key, loads: 0, delivered: 0 };
    existing.loads += 1;
    if (row.shipment.deliveredAt !== null) existing.delivered += 1;
    counts.set(key, existing);
  }

  return [...counts.values()].sort(
    (a, b) => b.loads - a.loads || a.name.localeCompare(b.name)
  );
}
