import { describe, expect, it } from "vitest";

import type { JourneyCheckpoint, Shipment } from "@/types/domain";

import {
  checkpointStates,
  currentPosition,
  journeyProgress,
  journeySummary,
  lateness,
  nextExpected,
  silenceDays,
  variance,
  type JourneyClock,
} from "./journey";

/**
 * Every test fixes `now`. Nothing here reads the clock, which is what makes
 * these rules assertable at all — and is why `src/lib` is forbidden from
 * touching an ambient clock in the first place.
 *
 * 15:00 on a Tuesday in Johannesburg. The hour matters: it is the afternoon,
 * which is precisely when a naive UTC comparison starts reporting today's
 * promises as broken.
 */
const NOW = new Date("2026-11-03T13:00:00Z"); // 15:00 SAST
const TZ = "Africa/Johannesburg";

const clock: JourneyClock = { now: NOW, timeZone: TZ, silenceThresholdDays: 2 };

function shipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    id: "s1",
    orgId: "o1",
    reference: "ALPHA-001",
    direction: "outbound",
    mode: "road",
    status: "in_transit",
    originLocationId: "l1",
    destinationLocationId: "l2",
    carrierName: null,
    vehicleRegistration: null,
    driverId: null,
    vehicleId: null,
    driverName: null,
    goodsDescription: null,
    cargoValue: null,
    currency: "ZAR",
    weightKg: null,
    plannedDispatchAt: null,
    plannedDeliveryAt: null,
    promisedDeliveryDate: null,
    dispatchedAt: "2026-11-02T06:00:00Z",
    deliveredAt: null,
    cancelledAt: null,
    silenceThresholdDays: null,
    lastEventAt: "2026-11-03T06:00:00Z",
    checkpointCount: 0,
    clearedCheckpointCount: 0,
    notes: null,
    createdAt: "2026-11-01T06:00:00Z",
    ...overrides,
  };
}

function checkpoint(
  seq: number,
  overrides: Partial<JourneyCheckpoint> = {}
): JourneyCheckpoint {
  return {
    id: `cp${seq}`,
    shipmentId: "s1",
    sequenceNo: seq,
    kind: "linehaul",
    label: `Stage ${seq}`,
    locationId: null,
    latitude: null,
    longitude: null,
    placeName: null,
    plannedAt: null,
    actualAt: null,
    exceptionKind: null,
    note: null,
    recordedAt: null,
    ...overrides,
  };
}

describe("currentPosition", () => {
  it("is null when nothing has been confirmed", () => {
    expect(currentPosition([checkpoint(100), checkpoint(200)])).toBeNull();
  });

  it("is the confirmed checkpoint with the latest actual time", () => {
    const cps = [
      checkpoint(100, { actualAt: "2026-11-02T06:00:00Z" }),
      checkpoint(200, { actualAt: "2026-11-03T06:00:00Z" }),
      checkpoint(300),
    ];
    expect(currentPosition(cps)?.sequenceNo).toBe(200);
  });

  it("breaks a tie on the higher sequence number", () => {
    // Two scans at one hub in the same minute is ordinary. The later stage is
    // the truthful answer to "how far has it got".
    const at = "2026-11-03T06:00:00Z";
    const cps = [
      checkpoint(100, { actualAt: at }),
      checkpoint(200, { actualAt: at }),
    ];
    expect(currentPosition(cps)?.sequenceNo).toBe(200);
  });

  it("is not confused by input order", () => {
    const cps = [
      checkpoint(300),
      checkpoint(100, { actualAt: "2026-11-02T06:00:00Z" }),
      checkpoint(200, { actualAt: "2026-11-03T06:00:00Z" }),
    ];
    expect(currentPosition(cps)?.sequenceNo).toBe(200);
  });
});

describe("nextExpected", () => {
  it("is the first pending stage after the current position", () => {
    const cps = [
      checkpoint(100, { actualAt: "2026-11-02T06:00:00Z" }),
      checkpoint(200),
      checkpoint(300),
    ];
    expect(nextExpected(cps)?.sequenceNo).toBe(200);
  });

  it("skips a stage that was passed without being scanned", () => {
    // The depot scan never happened, but the truck is already further on.
    // Reporting the missed scan as "next" would tell a dispatcher to wait for
    // something that is never coming.
    const cps = [
      checkpoint(100, { actualAt: "2026-11-02T06:00:00Z" }),
      checkpoint(200), // never scanned
      checkpoint(300, { actualAt: "2026-11-03T06:00:00Z" }),
      checkpoint(400),
    ];
    expect(nextExpected(cps)?.sequenceNo).toBe(400);
  });

  it("is null when every stage is confirmed", () => {
    const cps = [
      checkpoint(100, { actualAt: "2026-11-02T06:00:00Z" }),
      checkpoint(200, { actualAt: "2026-11-03T06:00:00Z" }),
    ];
    expect(nextExpected(cps)).toBeNull();
  });
});

describe("checkpointStates", () => {
  it("marks the furthest confirmed stage as current and earlier ones cleared", () => {
    const cps = [
      checkpoint(100, { actualAt: "2026-11-02T06:00:00Z" }),
      checkpoint(200, { actualAt: "2026-11-03T06:00:00Z" }),
      checkpoint(300),
    ];
    const states = checkpointStates(cps, clock);
    expect(states.get("cp100")).toBe("cleared");
    expect(states.get("cp200")).toBe("current");
    expect(states.get("cp300")).toBe("pending");
  });

  it("marks an unscanned stage below the furthest confirmed one as skipped", () => {
    const cps = [
      checkpoint(100, { actualAt: "2026-11-02T06:00:00Z" }),
      checkpoint(200),
      checkpoint(300, { actualAt: "2026-11-03T06:00:00Z" }),
    ];
    expect(checkpointStates(cps, clock).get("cp200")).toBe("skipped");
  });

  it("marks a pending stage whose planned time has passed as overdue", () => {
    const cps = [checkpoint(100, { plannedAt: "2026-11-03T06:00:00Z" })];
    expect(checkpointStates(cps, clock).get("cp100")).toBe("overdue");
  });

  it("leaves a pending stage with a future planned time alone", () => {
    const cps = [checkpoint(100, { plannedAt: "2026-11-04T06:00:00Z" })];
    expect(checkpointStates(cps, clock).get("cp100")).toBe("pending");
  });

  it("lets an exception override a confirmed stage", () => {
    const cps = [
      checkpoint(100, {
        actualAt: "2026-11-03T06:00:00Z",
        exceptionKind: "breakdown",
      }),
    ];
    expect(checkpointStates(cps, clock).get("cp100")).toBe("exception");
  });

  it("handles a shipment with no checkpoints at all", () => {
    expect(checkpointStates([], clock).size).toBe(0);
    expect(journeyProgress([])).toEqual({ cleared: 0, total: 0, fraction: 0 });
  });
});

describe("variance", () => {
  it("is positive when late and negative when early", () => {
    expect(variance("2026-11-03T06:00:00Z", "2026-11-03T08:40:00Z")).toBe(160);
    expect(variance("2026-11-03T06:00:00Z", "2026-11-03T05:45:00Z")).toBe(-15);
  });

  it("is null rather than a guess when either side is missing", () => {
    expect(variance(null, "2026-11-03T06:00:00Z")).toBeNull();
    expect(variance("2026-11-03T06:00:00Z", null)).toBeNull();
  });
});

describe("lateness — the day-boundary rules", () => {
  it("does NOT report a shipment promised today as late in the afternoon", () => {
    // The bug this whole design exists to prevent. It is 15:00 in
    // Johannesburg; the promise is for today; the day is not over. A board
    // that cries wolf every afternoon stops being read.
    const s = shipment({ promisedDeliveryDate: "2026-11-03" });
    expect(lateness(s, clock)).toBeNull();
  });

  it("reports a shipment promised yesterday as one day late", () => {
    const s = shipment({ promisedDeliveryDate: "2026-11-02" });
    expect(lateness(s, clock)?.days).toBe(1);
  });

  it("is null when nothing was ever promised", () => {
    expect(lateness(shipment(), clock)).toBeNull();
  });

  it("keeps a delivery late after it finally arrives", () => {
    // Lateness survives delivery. A late count that resets when the truck
    // arrives cannot report on performance, which is most of the product.
    const s = shipment({
      promisedDeliveryDate: "2026-11-01",
      deliveredAt: "2026-11-02T10:00:00Z",
      status: "delivered",
    });
    expect(lateness(s, clock)?.days).toBe(1);
  });

  it("does not call an on-time delivery late", () => {
    const s = shipment({
      promisedDeliveryDate: "2026-11-02",
      deliveredAt: "2026-11-02T10:00:00Z",
      status: "delivered",
    });
    expect(lateness(s, clock)).toBeNull();
  });

  it("does not call a delivery late when it arrived early", () => {
    const s = shipment({
      promisedDeliveryDate: "2026-11-05",
      deliveredAt: "2026-11-02T10:00:00Z",
      status: "delivered",
    });
    expect(lateness(s, clock)).toBeNull();
  });

  it("treats a late-evening delivery as still on the promised day", () => {
    // 23:30 SAST on the promised day is 21:30 UTC. Judged in UTC this would
    // be the right day by luck; judged an hour later it would not.
    const s = shipment({
      promisedDeliveryDate: "2026-11-02",
      deliveredAt: "2026-11-02T21:30:00Z",
      status: "delivered",
    });
    expect(lateness(s, clock)).toBeNull();
  });

  it("never reports a cancelled shipment as late", () => {
    const s = shipment({
      promisedDeliveryDate: "2026-10-01",
      cancelledAt: "2026-10-02T06:00:00Z",
      status: "cancelled",
    });
    expect(lateness(s, clock)).toBeNull();
  });
});

describe("silenceDays", () => {
  it("is null while updates are arriving", () => {
    expect(silenceDays(shipment(), clock)).toBeNull();
  });

  it("reports a shipment with no update for longer than the threshold", () => {
    const s = shipment({ lastEventAt: "2026-10-30T06:00:00Z" });
    expect(silenceDays(s, clock)).toBe(4);
  });

  it("never reports a delivered shipment as silent", () => {
    const s = shipment({
      lastEventAt: "2026-10-30T06:00:00Z",
      deliveredAt: "2026-10-30T06:00:00Z",
      status: "delivered",
    });
    expect(silenceDays(s, clock)).toBeNull();
  });

  it("never reports a cancelled shipment as silent", () => {
    const s = shipment({ lastEventAt: "2026-10-30T06:00:00Z", status: "cancelled" });
    expect(silenceDays(s, clock)).toBeNull();
  });

  it("falls back to dispatch, then creation, when nothing was ever logged", () => {
    const s = shipment({ lastEventAt: null, dispatchedAt: "2026-10-28T06:00:00Z" });
    expect(silenceDays(s, clock)).toBe(6);

    const never = shipment({
      lastEventAt: null,
      dispatchedAt: null,
      createdAt: "2026-10-25T06:00:00Z",
    });
    expect(silenceDays(never, clock)).toBe(9);
  });
});

describe("journeySummary — verdict precedence", () => {
  it("is on_track when nothing is wrong", () => {
    const s = shipment({ promisedDeliveryDate: "2026-11-10" });
    expect(journeySummary(s, [checkpoint(100)], clock).verdict).toBe("on_track");
  });

  it("reports at_risk when the next stage is already overdue", () => {
    // Not late yet — the promise is a week out. Saying so NOW is the product.
    const s = shipment({ promisedDeliveryDate: "2026-11-10" });
    const cps = [checkpoint(100, { plannedAt: "2026-11-03T06:00:00Z" })];
    expect(journeySummary(s, cps, clock).verdict).toBe("at_risk");
  });

  it("reports at_risk when the ETA has slipped past the promise", () => {
    const s = shipment({
      promisedDeliveryDate: "2026-11-05",
      plannedDeliveryAt: "2026-11-07T06:00:00Z",
    });
    expect(journeySummary(s, [], clock).verdict).toBe("at_risk");
  });

  it("prefers late over at_risk and silent", () => {
    const s = shipment({
      promisedDeliveryDate: "2026-11-01",
      lastEventAt: "2026-10-28T06:00:00Z",
    });
    expect(journeySummary(s, [], clock).verdict).toBe("late");
  });

  it("prefers exception over late", () => {
    const s = shipment({ promisedDeliveryDate: "2026-11-01" });
    const cps = [checkpoint(100, { exceptionKind: "damage", plannedAt: NOW.toISOString() })];
    expect(journeySummary(s, cps, clock).verdict).toBe("exception");
  });

  it("prefers delivered_late over everything except cancellation", () => {
    const s = shipment({
      promisedDeliveryDate: "2026-11-01",
      deliveredAt: "2026-11-02T06:00:00Z",
      status: "delivered",
    });
    const cps = [checkpoint(100, { exceptionKind: "delay", actualAt: "2026-11-02T06:00:00Z" })];
    expect(journeySummary(s, cps, clock).verdict).toBe("delivered_late");
  });

  it("prefers cancelled over all of it", () => {
    const s = shipment({
      promisedDeliveryDate: "2026-11-01",
      deliveredAt: "2026-11-02T06:00:00Z",
      cancelledAt: "2026-11-02T07:00:00Z",
      status: "cancelled",
    });
    expect(journeySummary(s, [], clock).verdict).toBe("cancelled");
  });

  it("reports silent when quiet but otherwise fine", () => {
    const s = shipment({
      promisedDeliveryDate: "2026-11-20",
      lastEventAt: "2026-10-29T06:00:00Z",
    });
    expect(journeySummary(s, [], clock).verdict).toBe("silent");
    expect(journeySummary(s, [], clock).silentForDays).toBe(5);
  });

  it("returns exactly one verdict for a shipment that is several things at once", () => {
    const s = shipment({
      promisedDeliveryDate: "2026-11-01",
      lastEventAt: "2026-10-20T06:00:00Z",
    });
    const cps = [checkpoint(100, { plannedAt: "2026-10-25T06:00:00Z" })];
    const summary = journeySummary(s, cps, clock);
    // late, at_risk and silent all apply. The board shows one badge.
    expect(summary.verdict).toBe("late");
    expect(typeof summary.verdict).toBe("string");
  });
});
