import type { JourneyCheckpoint, Shipment } from "@/types/domain";

import { calendarDaysBetween, dayIn, endOfDayIn } from "./date";

/**
 * The journey state machine.
 *
 * This is the product's judgement, and it lives here — pure, clock-free, taking
 * `now` and the organisation's timezone as arguments — so that every rule can
 * be asserted over fixed fixtures and re-run over history for a report.
 *
 * THE DATABASE COUNTS; THE LIBRARY JUDGES. `lastEventAt` and the checkpoint
 * counts are maintained by trigger because the board must sort hundreds of
 * shipments without reading every checkpoint. But late, at risk, silent and
 * current position are decided here. If "is this shipment late" is ever
 * decided inside a component, the architecture has failed.
 *
 * Two things this file deliberately does NOT do:
 *
 *   It never interpolates a position. A shipment is at its last confirmed
 *   checkpoint, full stop. A dot drawn between two stages is a fabricated GPS
 *   fix, and the day a customer discovers the dot was a guess, every other
 *   number on the page becomes a guess too.
 *
 *   It never invents an ETA. A stage with no planned time has no planned time.
 */

export type CheckpointState =
  /** Confirmed: it happened. */
  | "cleared"
  /** The furthest confirmed point — where the load is now. */
  | "current"
  /** Not yet due. */
  | "pending"
  /** Planned time has passed with nothing confirmed. */
  | "overdue"
  /** Never confirmed, but a later stage was. */
  | "skipped"
  /** Something went wrong here. Overrides everything else. */
  | "exception";

export type ShipmentVerdict =
  | "cancelled"
  | "delivered_late"
  | "delivered"
  | "exception"
  | "late"
  | "at_risk"
  | "silent"
  | "on_track";

/**
 * Precedence, highest first. The board shows exactly ONE badge per row: a row
 * wearing four badges communicates nothing at all.
 */
const VERDICT_ORDER: ShipmentVerdict[] = [
  "cancelled",
  "delivered_late",
  "delivered",
  "exception",
  "late",
  "at_risk",
  "silent",
  "on_track",
];

export interface JourneyClock {
  now: Date;
  /** IANA zone of the organisation that owns the shipment. */
  timeZone: string;
  /** Days of silence before a shipment is reported quiet. */
  silenceThresholdDays: number;
}

export interface JourneyState {
  verdict: ShipmentVerdict;
  states: Map<string, CheckpointState>;
  current: JourneyCheckpoint | null;
  next: JourneyCheckpoint | null;
  /** Whole days late. Null when not late. */
  lateByDays: number | null;
  /** Whole days since the last confirmed event. Null when not silent. */
  silentForDays: number | null;
  progress: { cleared: number; total: number; fraction: number };
  /** Minutes between promised and actual delivery. Negative is early. */
  deliveryVarianceMinutes: number | null;
}

function parse(iso: string | null): Date | null {
  return iso ? new Date(iso) : null;
}

/** Ordered by sequence. Callers should not rely on input order. */
function ordered(checkpoints: JourneyCheckpoint[]): JourneyCheckpoint[] {
  return [...checkpoints].sort((a, b) => a.sequenceNo - b.sequenceNo);
}

/**
 * Where the load actually is: the confirmed checkpoint with the latest actual
 * time.
 *
 * Ties break on the HIGHER sequence number, not the lower. Two scans at the
 * same minute in one hub are ordinary, and the later stage is the truthful
 * answer to "how far has it got".
 */
export function currentPosition(
  checkpoints: JourneyCheckpoint[]
): JourneyCheckpoint | null {
  let best: JourneyCheckpoint | null = null;
  let bestAt = -Infinity;

  for (const cp of checkpoints) {
    const actual = parse(cp.actualAt);
    if (!actual) continue;

    const t = actual.getTime();
    if (t > bestAt || (t === bestAt && best && cp.sequenceNo > best.sequenceNo)) {
      best = cp;
      bestAt = t;
    }
  }

  return best;
}

/**
 * The next stage expected to happen.
 *
 * Deliberately NOT "the lowest pending checkpoint". A depot scan that never
 * happened while the truck is already in Durban is *skipped*, not next — and
 * reporting it as next would tell a dispatcher to wait for something that is
 * never coming.
 */
export function nextExpected(
  checkpoints: JourneyCheckpoint[]
): JourneyCheckpoint | null {
  const current = currentPosition(checkpoints);
  const floor = current ? current.sequenceNo : -Infinity;

  return (
    ordered(checkpoints).find((cp) => !cp.actualAt && cp.sequenceNo > floor) ?? null
  );
}

/**
 * Minutes between a planned and an actual time. Positive is late.
 * Null when either side is missing — never a guess.
 */
export function variance(
  plannedAt: string | null,
  actualAt: string | null
): number | null {
  const planned = parse(plannedAt);
  const actual = parse(actualAt);
  if (!planned || !actual) return null;

  return Math.round((actual.getTime() - planned.getTime()) / 60_000);
}

export function journeyProgress(checkpoints: JourneyCheckpoint[]) {
  const total = checkpoints.length;
  const cleared = checkpoints.filter((cp) => cp.actualAt !== null).length;
  return { cleared, total, fraction: total === 0 ? 0 : cleared / total };
}

/** The state of every checkpoint, keyed by id. */
export function checkpointStates(
  checkpoints: JourneyCheckpoint[],
  clock: JourneyClock
): Map<string, CheckpointState> {
  const list = ordered(checkpoints);
  const current = currentPosition(list);
  const states = new Map<string, CheckpointState>();

  // The highest sequence number that has actually been confirmed. Anything
  // pending below this line was passed without being scanned.
  const highestCleared = list.reduce(
    (max, cp) => (cp.actualAt ? Math.max(max, cp.sequenceNo) : max),
    -Infinity
  );

  for (const cp of list) {
    // An exception wins regardless of timing: something went wrong here, and
    // that is the most important thing about this stage.
    if (cp.exceptionKind) {
      states.set(cp.id, "exception");
      continue;
    }

    if (cp.actualAt) {
      states.set(cp.id, current && cp.id === current.id ? "current" : "cleared");
      continue;
    }

    if (cp.sequenceNo < highestCleared) {
      // Rendered struck through, never hidden and never silently reordered.
      // "The depot scan never happened but the truck is in Durban" is a real
      // and common operational fact, and concealing it helps nobody.
      states.set(cp.id, "skipped");
      continue;
    }

    const planned = parse(cp.plannedAt);
    states.set(
      cp.id,
      planned && planned.getTime() < clock.now.getTime() ? "overdue" : "pending"
    );
  }

  return states;
}

/**
 * How many whole days past its promise a shipment is. Null when it is not
 * late.
 *
 * A shipment promised TODAY is not late at 15:00 — the day is not over. This
 * is the single most important line in the file: get it wrong and the board
 * reports a false alarm every afternoon.
 */
export function lateness(
  shipment: Shipment,
  clock: JourneyClock
): { days: number } | null {
  const promised = shipment.promisedDeliveryDate;
  if (!promised) return null;
  if (shipment.cancelledAt) return null;

  const today = dayIn(clock.now, clock.timeZone);

  if (shipment.deliveredAt) {
    // Lateness SURVIVES delivery. A product whose late count resets when the
    // truck arrives cannot report on performance, which is most of what the
    // customer is buying.
    const deliveredDay = dayIn(new Date(shipment.deliveredAt), clock.timeZone);
    if (deliveredDay <= promised) return null;
    return {
      days: calendarDaysBetween(
        endOfDayIn(promised, clock.timeZone),
        new Date(shipment.deliveredAt),
        clock.timeZone
      ),
    };
  }

  if (promised >= today) return null;

  return {
    days: calendarDaysBetween(
      endOfDayIn(promised, clock.timeZone),
      clock.now,
      clock.timeZone
    ),
  };
}

/**
 * Whole days since the last confirmed event, when that exceeds the threshold.
 * Null when the shipment is not silent.
 *
 * Silence is measured from the last thing that actually happened — falling
 * back to dispatch, then to creation, because a shipment that has never had a
 * checkpoint logged is the quietest kind there is.
 */
export function silenceDays(
  shipment: Shipment,
  clock: JourneyClock
): number | null {
  if (shipment.status === "delivered" || shipment.status === "cancelled") {
    return null;
  }

  const since =
    parse(shipment.lastEventAt) ??
    parse(shipment.dispatchedAt) ??
    parse(shipment.createdAt);
  if (!since) return null;

  const days = calendarDaysBetween(since, clock.now, clock.timeZone);
  return days >= clock.silenceThresholdDays ? days : null;
}

/**
 * Not late yet, but heading that way.
 *
 * THIS IS THE PRODUCT. Anyone can report that a delivery was late yesterday.
 * Saying on Tuesday that Thursday is in trouble is the part worth paying for.
 */
export function isAtRisk(
  shipment: Shipment,
  nextExpectedOverdue: boolean,
  clock: JourneyClock
): boolean {
  if (shipment.deliveredAt || shipment.cancelledAt) return false;
  if (nextExpectedOverdue) return true;

  // The operational ETA has slipped past the commercial promise. The promise
  // is not broken yet, which is exactly why it is worth saying out loud now.
  if (shipment.promisedDeliveryDate && shipment.plannedDeliveryAt) {
    const promiseEnds = endOfDayIn(shipment.promisedDeliveryDate, clock.timeZone);
    if (new Date(shipment.plannedDeliveryAt).getTime() > promiseEnds.getTime()) {
      return true;
    }
  }

  return false;
}

/**
 * The single verdict for a shipment.
 *
 * Takes FLAGS rather than checkpoints, deliberately. The journey view has
 * every checkpoint loaded and derives them; the oversight board has hundreds
 * of shipments and gets the same two facts from cheap indexed queries instead.
 * Both call this, so the board and the detail page can never disagree about
 * whether something is late — which they would, inevitably, as two
 * implementations.
 */
export function verdictFor(
  shipment: Shipment,
  flags: { hasException: boolean; nextExpectedOverdue: boolean },
  clock: JourneyClock
): ShipmentVerdict {
  const late = lateness(shipment, clock);
  const silent = silenceDays(shipment, clock);

  const candidates = new Set<ShipmentVerdict>();

  if (shipment.cancelledAt) candidates.add("cancelled");
  if (shipment.deliveredAt) candidates.add(late ? "delivered_late" : "delivered");
  if (flags.hasException) candidates.add("exception");
  if (late && !shipment.deliveredAt) candidates.add("late");
  if (isAtRisk(shipment, flags.nextExpectedOverdue, clock)) candidates.add("at_risk");
  if (silent !== null) candidates.add("silent");

  return VERDICT_ORDER.find((v) => candidates.has(v)) ?? "on_track";
}

export function journeySummary(
  shipment: Shipment,
  checkpoints: JourneyCheckpoint[],
  clock: JourneyClock
): JourneyState {
  const states = checkpointStates(checkpoints, clock);
  const late = lateness(shipment, clock);
  const silentForDays = silenceDays(shipment, clock);

  // Derived here from the checkpoints this view already has, then handed to
  // the same verdict function the board uses.
  const next = nextExpected(checkpoints);
  const nextPlanned = next ? parse(next.plannedAt) : null;

  const verdict = verdictFor(
    shipment,
    {
      hasException: [...states.values()].includes("exception"),
      nextExpectedOverdue: Boolean(
        nextPlanned && nextPlanned.getTime() < clock.now.getTime()
      ),
    },
    clock
  );

  return {
    verdict,
    states,
    current: currentPosition(checkpoints),
    next: nextExpected(checkpoints),
    lateByDays: late?.days ?? null,
    silentForDays,
    progress: journeyProgress(checkpoints),
    deliveryVarianceMinutes: variance(
      shipment.plannedDeliveryAt,
      shipment.deliveredAt
    ),
  };
}
