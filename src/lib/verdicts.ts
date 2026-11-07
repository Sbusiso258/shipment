import type { ShipmentVerdict } from "./journey";

/**
 * What each verdict is CALLED, in one place.
 *
 * This exists because two components kept their own copy and drifted:
 * `verdict-badge.tsx` called `on_track` "On track" while the dashboard's
 * shipments panel called it "In transit". The second is not a synonym — it
 * asserts the load is moving, and `on_track` is a judgement about LATENESS
 * that a shipment wears from the moment it is recorded, before it has been
 * dispatched at all.
 *
 * So the board announced a load was in transit while the shipment page beside
 * it still offered "Mark dispatched". Nothing failed; the two screens simply
 * disagreed, which is the one thing `AGENTS.md` says the product must never
 * do — "two parts of the product telling the customer different things".
 *
 * A label is presentation, so this is only *just* a library concern. It lives
 * here anyway: the bug was not a wrong word, it was the SAME word being owned
 * twice, and a shared constant is the only fix that cannot drift again.
 */
export const VERDICT_LABELS: Record<ShipmentVerdict, string> = {
  cancelled: "Cancelled",
  delivered_late: "Delivered late",
  delivered: "Delivered",
  exception: "Exception",
  late: "Late",
  at_risk: "At risk",
  // "No updates" rather than "Silent": the shipment is not quiet, the people
  // handling it have stopped reporting, and the operator reading this needs to
  // know which of the two it is.
  silent: "No updates",
  on_track: "On track",
};

export function verdictLabel(verdict: ShipmentVerdict): string {
  return VERDICT_LABELS[verdict];
}
