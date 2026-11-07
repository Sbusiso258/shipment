import { describe, expect, it } from "vitest";

import type { JourneyCheckpoint, Shipment } from "@/types/domain";

import { buildFeed } from "./feed";

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
    dispatchedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    silenceThresholdDays: null,
    lastEventAt: null,
    checkpointCount: 0,
    clearedCheckpointCount: 0,
    notes: null,
    createdAt: "2026-11-01T06:00:00Z",
    ...overrides,
  };
}

function checkpoint(overrides: Partial<JourneyCheckpoint> = {}): JourneyCheckpoint {
  return {
    id: "cp1",
    shipmentId: "s1",
    sequenceNo: 100,
    kind: "linehaul",
    label: "Passed Harrismith",
    locationId: null,
    latitude: null,
    longitude: null,
    placeName: "Harrismith",
    plannedAt: null,
    actualAt: "2026-11-03T09:00:00Z",
    exceptionKind: null,
    note: null,
    recordedAt: null,
    ...overrides,
  };
}

describe("buildFeed", () => {
  it("names the shipment a checkpoint belongs to", () => {
    const feed = buildFeed({ shipments: [shipment()], checkpoints: [checkpoint()] });
    expect(feed[0].title).toBe("Shipment update");
    expect(feed[0].detail).toBe("ALPHA-001 — Passed Harrismith at Harrismith");
  });

  it("ignores a checkpoint that has not happened yet", () => {
    // A planned stage belongs on the spine as "pending", not in a stream of
    // things that did happen.
    const feed = buildFeed({
      shipments: [shipment()],
      checkpoints: [checkpoint({ actualAt: null, plannedAt: "2026-11-04T06:00:00Z" })],
    });
    expect(feed).toHaveLength(0);
  });

  it("raises an exception checkpoint into its own category", () => {
    const feed = buildFeed({
      shipments: [shipment()],
      checkpoints: [checkpoint({ exceptionKind: "breakdown" })],
    });
    expect(feed[0].category).toBe("alert");
    expect(feed[0].title).toBe("Breakdown");
  });

  it("keeps the operator's note out of the stream", () => {
    // The note can hold internal commentary, and a party organisation reads
    // this stream. It stays on the journey spine, where the context is.
    const feed = buildFeed({
      shipments: [shipment()],
      checkpoints: [
        checkpoint({ exceptionKind: "damage", note: "Driver suspects the loader" }),
      ],
    });
    expect(JSON.stringify(feed)).not.toContain("loader");
  });

  it("derives lifecycle events from stored instants", () => {
    const feed = buildFeed({
      shipments: [
        shipment({
          dispatchedAt: "2026-11-02T06:00:00Z",
          deliveredAt: "2026-11-03T15:00:00Z",
        }),
      ],
      checkpoints: [],
    });

    expect(feed.map((e) => e.title)).toEqual(["Delivery confirmed", "Dispatched"]);
  });

  it("does not invent an event for a shipment put on hold", () => {
    // `status` records current state only and there is no on_hold timestamp,
    // so there is nothing honest to show. The gap is real and stays visible.
    const feed = buildFeed({
      shipments: [shipment({ status: "on_hold" })],
      checkpoints: [],
    });
    expect(feed).toHaveLength(0);
  });

  it("orders newest first across both sources", () => {
    const feed = buildFeed({
      shipments: [shipment({ dispatchedAt: "2026-11-01T06:00:00Z" })],
      checkpoints: [
        checkpoint({ id: "early", actualAt: "2026-11-02T06:00:00Z" }),
        checkpoint({ id: "late", actualAt: "2026-11-03T06:00:00Z" }),
      ],
    });

    expect(feed.map((e) => e.id)).toEqual([
      "checkpoint:late",
      "checkpoint:early",
      "shipment:dispatched:s1",
    ]);
  });

  it("orders ties deterministically rather than by arrival", () => {
    const at = "2026-11-03T06:00:00Z";
    const forwards = buildFeed({
      shipments: [],
      checkpoints: [checkpoint({ id: "b", actualAt: at }), checkpoint({ id: "a", actualAt: at })],
    });
    const backwards = buildFeed({
      shipments: [],
      checkpoints: [checkpoint({ id: "a", actualAt: at }), checkpoint({ id: "b", actualAt: at })],
    });
    expect(forwards.map((e) => e.id)).toEqual(backwards.map((e) => e.id));
  });

  it("caps the whole stream, not each source", () => {
    const checkpoints = Array.from({ length: 30 }, (_, i) =>
      checkpoint({ id: `cp${i}`, actualAt: `2026-11-03T${String(i % 24).padStart(2, "0")}:00:00Z` })
    );
    expect(buildFeed({ shipments: [], checkpoints }, 5)).toHaveLength(5);
  });

  it("copes with a checkpoint whose shipment is not loaded", () => {
    // RLS can return a checkpoint for a shipment the caller can see while the
    // board query was limited — the stream must not crash or print "undefined".
    const feed = buildFeed({ shipments: [], checkpoints: [checkpoint()] });
    expect(feed[0].detail).toBe("A shipment — Passed Harrismith at Harrismith");
    expect(feed[0].shipmentReference).toBeNull();
  });
});
