import { describe, expect, it } from "vitest";

import type { Shipment } from "@/types/domain";

import { onTimeReport } from "./reports";

function shipment(over: Partial<Shipment>): Shipment {
  return {
    id: "s1",
    orgId: "o1",
    reference: "REF",
    direction: "outbound",
    mode: "road",
    status: "delivered",
    originLocationId: "l1",
    destinationLocationId: "l2",
    carrierName: null,
    vehicleRegistration: null,
    driverName: null,
    goodsDescription: null,
    cargoValue: null,
    currency: "ZAR",
    weightKg: null,
    plannedDispatchAt: null,
    plannedDeliveryAt: null,
    promisedDeliveryDate: null,
    dispatchedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    silenceThresholdDays: null,
    lastEventAt: null,
    checkpointCount: 0,
    clearedCheckpointCount: 0,
    notes: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    ...over,
  } as Shipment;
}

const SAST = "Africa/Johannesburg";

describe("onTimeReport", () => {
  it("is not late at 15:00 on the promised day", () => {
    // The whole reason promised_delivery_date is a date. Judged against an
    // instant, this delivery would read as late every afternoon.
    const report = onTimeReport(
      [
        shipment({
          promisedDeliveryDate: "2026-11-05",
          deliveredAt: "2026-11-05T13:00:00.000Z", // 15:00 SAST
        }),
      ],
      SAST
    );
    expect(report.onTime).toBe(1);
    expect(report.late).toBe(0);
  });

  it("is late just after the promised day ends, in the org's zone", () => {
    const report = onTimeReport(
      [
        shipment({
          promisedDeliveryDate: "2026-11-05",
          deliveredAt: "2026-11-05T22:30:00.000Z", // 00:30 on the 6th, SAST
        }),
      ],
      SAST
    );
    expect(report.late).toBe(1);
  });

  it("counts a delivery with no promise as unjudgeable, not as on time", () => {
    const report = onTimeReport(
      [shipment({ deliveredAt: "2026-11-05T10:00:00.000Z" })],
      SAST
    );
    expect(report.unjudgeable).toBe(1);
    expect(report.onTime).toBe(0);
    expect(report.rate).toBeNull();
  });

  it("ignores shipments that have not been delivered", () => {
    const report = onTimeReport(
      [shipment({ promisedDeliveryDate: "2026-11-05", deliveredAt: null })],
      SAST
    );
    expect(report.onTime + report.late + report.unjudgeable).toBe(0);
  });

  it("reports no rate rather than 0% when there is nothing to judge", () => {
    // "Nothing delivered yet" and "nothing arrived on time" must not render
    // the same.
    expect(onTimeReport([], SAST).rate).toBeNull();
  });

  it("rounds the rate", () => {
    const report = onTimeReport(
      [
        shipment({ promisedDeliveryDate: "2026-11-05", deliveredAt: "2026-11-05T10:00:00.000Z" }),
        shipment({ promisedDeliveryDate: "2026-11-05", deliveredAt: "2026-11-05T10:00:00.000Z" }),
        shipment({ promisedDeliveryDate: "2026-11-05", deliveredAt: "2026-11-06T10:00:00.000Z" }),
      ],
      SAST
    );
    expect(report.rate).toBe(67);
  });
});
