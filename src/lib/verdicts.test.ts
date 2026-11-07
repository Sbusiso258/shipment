import { describe, expect, it } from "vitest";

import type { ShipmentVerdict } from "./journey";
import { VERDICT_LABELS, verdictLabel } from "./verdicts";

const ALL: ShipmentVerdict[] = [
  "cancelled",
  "delivered_late",
  "delivered",
  "exception",
  "late",
  "at_risk",
  "silent",
  "on_track",
];

describe("verdictLabel", () => {
  it("has a label for every verdict", () => {
    for (const verdict of ALL) {
      expect(verdictLabel(verdict), verdict).toBeTruthy();
    }
    expect(Object.keys(VERDICT_LABELS).sort()).toEqual([...ALL].sort());
  });

  /**
   * THE BUG THIS FILE EXISTS FOR.
   *
   * The dashboard panel labelled `on_track` "In transit" while
   * `verdict-badge.tsx` labelled it "On track". A verdict is a judgement about
   * LATENESS — `on_track` means "not late", and a shipment wears it from the
   * moment it is recorded, before it has been dispatched. So the board said a
   * load was in transit while the shipment page beside it still offered "Mark
   * dispatched".
   *
   * No verdict label may assert movement, delivery or position, because none
   * of them is what a verdict measures.
   */
  it("never claims a load is moving", () => {
    for (const verdict of ALL) {
      expect(verdictLabel(verdict).toLowerCase(), verdict).not.toContain("transit");
      expect(verdictLabel(verdict).toLowerCase(), verdict).not.toContain("moving");
      expect(verdictLabel(verdict).toLowerCase(), verdict).not.toContain("en route");
    }
  });

  it("reserves delivery words for the verdicts that mean it", () => {
    const delivered = ALL.filter((v) => verdictLabel(v).toLowerCase().includes("deliver"));
    expect(delivered.sort()).toEqual(["delivered", "delivered_late"]);
  });

  // `on_track` is the one most easily mistaken for a movement state, so it is
  // pinned by name rather than left to the sweep above.
  it("calls on_track 'On track'", () => {
    expect(verdictLabel("on_track")).toBe("On track");
  });

  // "Silent" describes the shipment; "No updates" describes what is actually
  // wrong, which is that people stopped reporting.
  it("says what is wrong rather than naming the state", () => {
    expect(verdictLabel("silent")).toBe("No updates");
  });
});
