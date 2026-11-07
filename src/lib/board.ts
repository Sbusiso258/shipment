import type { LocationPoint, Shipment } from "@/types/domain";

import { lateness, silenceDays, type JourneyClock, type ShipmentVerdict } from "./journey";

/**
 * The oversight board: what needs attention, worst first.
 *
 * Pure, like everything in `src/lib`. The caller supplies `now`, the
 * organisation's timezone and the verdict flags from its own cheap queries.
 *
 * The board exists to answer one question — "what should I deal with before I
 * go home?" — so the ordering IS the feature. A board that lists shipments by
 * creation date is a table; a board that puts the broken promise at the top is
 * an oversight tool.
 */

export interface BoardRow {
  shipment: Shipment;
  verdict: ShipmentVerdict;
  /** Where it is now, for the row's secondary line. Null before dispatch. */
  currentLabel: string | null;
  originName: string;
  destinationName: string;
  /**
   * Where the two ends ARE, for the map's pickup and delivery pins.
   *
   * Null when the place has no coordinate at all — neither an exact pin nor a
   * town from the gazetteer. The map then draws nothing there rather than
   * inventing a position, which is the rule this whole product rests on.
   */
  originPoint: LocationPoint | null;
  destinationPoint: LocationPoint | null;
}

/**
 * How much attention each verdict deserves, highest first.
 *
 * Note this is NOT the same as the precedence order used to pick a single
 * verdict. Precedence answers "which one label is true"; this answers "which
 * one do I deal with first". `delivered_late` outranks `delivered` as a label,
 * but neither needs action today — they are history, and they sort to the
 * bottom.
 */
const ATTENTION: Record<ShipmentVerdict, number> = {
  exception: 0,
  late: 1,
  at_risk: 2,
  silent: 3,
  on_track: 4,
  delivered_late: 5,
  delivered: 6,
  cancelled: 7,
};

/** Verdicts that mean somebody has to do something. */
export const NEEDS_ATTENTION: ShipmentVerdict[] = [
  "exception",
  "late",
  "at_risk",
  "silent",
];

export function needsAttention(verdict: ShipmentVerdict): boolean {
  return NEEDS_ATTENTION.includes(verdict);
}

/**
 * Worst first; within a verdict, the one that has been wrong longest.
 *
 * The tie-break matters more than it looks. Ten late shipments in creation
 * order is a list to read; ten late shipments with the five-days-late one at
 * the top is a list to act on.
 */
export function sortByTrouble(
  rows: BoardRow[],
  clock: JourneyClock
): BoardRow[] {
  return [...rows].sort((a, b) => {
    const byAttention = ATTENTION[a.verdict] - ATTENTION[b.verdict];
    if (byAttention !== 0) return byAttention;

    const severity = (row: BoardRow) =>
      (lateness(row.shipment, clock)?.days ?? 0) +
      (silenceDays(row.shipment, clock) ?? 0);

    const bySeverity = severity(b) - severity(a);
    if (bySeverity !== 0) return bySeverity;

    // Stable, readable last resort. Without it the order of two otherwise
    // equal rows depends on however the database happened to return them,
    // which makes the board shuffle between refreshes for no reason.
    return a.shipment.reference.localeCompare(b.shipment.reference, "en");
  });
}

export interface ValueAtRisk {
  /** Summed cargo value of the shipments needing attention. */
  amount: number;
  currency: string;
  /** How many of those shipments actually carried a value. */
  disclosedCount: number;
  /**
   * How many did not. REPORTED, never silently folded in as zero — the figure
   * is a floor, and saying so is the difference between a number that can be
   * trusted and one that cannot.
   */
  undisclosedCount: number;
  /** True when more than one currency is present and the total is meaningless. */
  mixedCurrency: boolean;
}

/**
 * The rand value of what is going wrong.
 *
 * `cargoValue` is nullable and null means NOT DISCLOSED. Treating that as zero
 * would quietly understate the single number the board exists to headline, so
 * undisclosed shipments are counted separately and shown beside the total.
 */
export function valueAtRisk(rows: BoardRow[]): ValueAtRisk {
  const troubled = rows.filter((row) => needsAttention(row.verdict));

  let amount = 0;
  let disclosedCount = 0;
  let undisclosedCount = 0;
  const currencies = new Set<string>();

  for (const { shipment } of troubled) {
    if (shipment.cargoValue === null) {
      undisclosedCount += 1;
      continue;
    }
    amount += shipment.cargoValue;
    disclosedCount += 1;
    currencies.add(shipment.currency);
  }

  return {
    amount,
    currency: currencies.size === 1 ? [...currencies][0] : "ZAR",
    disclosedCount,
    undisclosedCount,
    // Summing across currencies gives a number that means nothing. Better to
    // say so than to print it.
    mixedCurrency: currencies.size > 1,
  };
}

export type BoardCounts = Record<ShipmentVerdict, number>;

export function countByVerdict(rows: BoardRow[]): BoardCounts {
  const counts = Object.fromEntries(
    (Object.keys(ATTENTION) as ShipmentVerdict[]).map((v) => [v, 0])
  ) as BoardCounts;

  for (const row of rows) counts[row.verdict] += 1;
  return counts;
}

export interface BoardSummary {
  counts: BoardCounts;
  attentionCount: number;
  value: ValueAtRisk;
  rows: BoardRow[];
}

export function boardSummary(rows: BoardRow[], clock: JourneyClock): BoardSummary {
  return {
    counts: countByVerdict(rows),
    attentionCount: rows.filter((row) => needsAttention(row.verdict)).length,
    value: valueAtRisk(rows),
    rows: sortByTrouble(rows, clock),
  };
}

/** `R 1 240 000`. South African convention: space as the thousands separator. */
export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * The search box and the status filter on the shipments panel.
 *
 * Pure, and here rather than in the component, because "does this row match"
 * is a judgement and judgements are testable. Filtering happens over rows
 * already loaded — at V1 volumes the board fetches every open shipment
 * anyway, so a round trip per keystroke would buy nothing.
 */
export function filterRows(
  rows: BoardRow[],
  options: { query?: string; verdict?: ShipmentVerdict | null }
): BoardRow[] {
  const query = options.query?.trim().toLowerCase() ?? "";
  const verdict = options.verdict ?? null;

  return rows.filter((row) => {
    if (verdict !== null && row.verdict !== verdict) return false;
    if (query === "") return true;

    // Reference first, because that is what the box asks for — but a person
    // looking for "the Durban one" should find it too, and both endpoint
    // names are already on the row.
    return (
      row.shipment.reference.toLowerCase().includes(query) ||
      row.originName.toLowerCase().includes(query) ||
      row.destinationName.toLowerCase().includes(query)
    );
  });
}

/**
 * "3 of 5 stages", or "No stages planned".
 *
 * A shipment with no checkpoints at all is not 0% complete — nobody has said
 * what its route is yet, and rendering "0 of 0" as progress would imply they
 * had.
 */
export function stagesLabel(shipment: Shipment): string {
  if (shipment.checkpointCount === 0) return "No stages planned";
  return `${shipment.clearedCheckpointCount} of ${shipment.checkpointCount} stages`;
}
