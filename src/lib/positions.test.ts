import { describe, expect, it } from "vitest";

import type { JourneyCheckpoint } from "@/types/domain";

import { lastConfirmedPositions } from "./positions";

function checkpoint(over: Partial<JourneyCheckpoint>): JourneyCheckpoint {
  return {
    id: "c1",
    shipmentId: "s1",
    sequenceNo: 100,
    kind: "linehaul",
    label: "Somewhere",
    locationId: null,
    latitude: -26.2,
    longitude: 28.0,
    plannedAt: null,
    actualAt: "2026-11-01T08:00:00.000Z",
    exceptionKind: null,
    note: null,
    recordedAt: "2026-11-01T08:00:00.000Z",
    placeName: null,
    ...over,
  } as JourneyCheckpoint;
}

describe("lastConfirmedPositions", () => {
  it("ignores stages that have not happened", () => {
    const positions = lastConfirmedPositions([
      checkpoint({ id: "a", sequenceNo: 100 }),
      checkpoint({ id: "b", sequenceNo: 200, actualAt: null }),
    ]);
    expect(positions.get("s1")?.checkpointId).toBe("a");
  });

  it("ignores stages with no coordinates", () => {
    const positions = lastConfirmedPositions([
      checkpoint({ id: "a", sequenceNo: 100 }),
      checkpoint({ id: "b", sequenceNo: 200, latitude: null, longitude: null }),
    ]);
    expect(positions.get("s1")?.checkpointId).toBe("a");
  });

  it("takes the furthest along the route, not the most recently typed", () => {
    // The Harrismith stop is confirmed AFTER the Ladysmith one, late. The pin
    // must not drag backwards down the route because somebody caught up on
    // their paperwork out of order.
    const positions = lastConfirmedPositions([
      checkpoint({
        id: "ladysmith",
        sequenceNo: 300,
        actualAt: "2026-11-01T06:00:00.000Z",
      }),
      checkpoint({
        id: "harrismith",
        sequenceNo: 200,
        actualAt: "2026-11-01T18:00:00.000Z",
      }),
    ]);
    expect(positions.get("s1")?.checkpointId).toBe("ladysmith");
  });

  it("keeps one position per shipment", () => {
    const positions = lastConfirmedPositions([
      checkpoint({ id: "a", shipmentId: "s1", sequenceNo: 100 }),
      checkpoint({ id: "b", shipmentId: "s2", sequenceNo: 100 }),
      checkpoint({ id: "c", shipmentId: "s1", sequenceNo: 200 }),
    ]);
    expect(positions.size).toBe(2);
    expect(positions.get("s1")?.checkpointId).toBe("c");
  });

  it("returns nothing when nothing has been confirmed anywhere", () => {
    expect(
      lastConfirmedPositions([checkpoint({ actualAt: null })]).size
    ).toBe(0);
  });
});
