import { describe, expect, it } from "vitest";

import {
  mapAnnouncement,
  mapCheckpoint,
  mapLocationPoint,
  mapLocationRow,
  mapMessage,
  mapShipment,
  mapTask,
  type AnnouncementRow,
  type CheckpointRow,
  type LocationPointRow,
  type LocationRow,
  type MessageRow,
  type ShipmentRow,
  type TaskRow,
} from "./mappers";

/**
 * These exist to catch the one bug this layer actually produces: a mistyped
 * column name, which yields `undefined` and renders as a blank cell rather
 * than failing. Without a live database, this is the only cheap way to find
 * it.
 */

const shipmentRow: ShipmentRow = {
  id: "s1",
  org_id: "o1",
  reference: "ALPHA-001",
  direction: "outbound",
  mode: "road",
  status: "in_transit",
  origin_location_id: "l1",
  destination_location_id: "l2",
  carrier_name: "Carrier",
  driver_id: "d1",
  vehicle_id: "v1",
  vehicle_registration: "CA 123-456",
  driver_name: "Driver",
  goods_description: "Pallets",
  cargo_value: "125000.50",
  currency: "ZAR",
  weight_kg: "1200.500",
  planned_dispatch_at: "2026-11-02T06:00:00Z",
  planned_delivery_at: "2026-11-03T06:00:00Z",
  promised_delivery_date: "2026-11-04",
  dispatched_at: "2026-11-02T07:00:00Z",
  delivered_at: null,
  cancelled_at: null,
  silence_threshold_days: 3,
  last_event_at: "2026-11-03T06:00:00Z",
  checkpoint_count: 5,
  cleared_checkpoint_count: 3,
  notes: "Fragile",
  created_at: "2026-11-01T06:00:00Z",
};

describe("mapShipment", () => {
  it("maps every field without leaving anything undefined", () => {
    const shipment = mapShipment(shipmentRow);

    // A mistyped column name produces undefined, which renders as a blank
    // cell. Asserting the shape catches that, where spot-checking would not.
    for (const [key, value] of Object.entries(shipment)) {
      expect(value, `${key} should not be undefined`).not.toBeUndefined();
    }
  });

  it("converts numeric strings to numbers at the boundary", () => {
    // Postgres sends `numeric` as a string on purpose — a float cannot hold
    // every decimal exactly, and silently rounding money is how a refund
    // becomes revenue.
    const shipment = mapShipment(shipmentRow);
    expect(shipment.cargoValue).toBe(125000.5);
    expect(shipment.weightKg).toBe(1200.5);
  });

  it("keeps an undisclosed cargo value null rather than coercing it to 0", () => {
    const shipment = mapShipment({ ...shipmentRow, cargo_value: null });
    expect(shipment.cargoValue).toBeNull();
  });

  it("maps the snake_case names the database actually uses", () => {
    const shipment = mapShipment(shipmentRow);
    expect(shipment.promisedDeliveryDate).toBe("2026-11-04");
    expect(shipment.clearedCheckpointCount).toBe(3);
    expect(shipment.originLocationId).toBe("l1");
    // The fleet link from 0011. These two spent a release in the schema
    // without being read by anything, so the mapper is where that shows.
    expect(shipment.driverId).toBe("d1");
    expect(shipment.vehicleId).toBe("v1");
    expect(shipment.silenceThresholdDays).toBe(3);
  });
});

const checkpointRow: CheckpointRow = {
  id: "cp1",
  shipment_id: "s1",
  sequence_no: 100,
  kind: "pickup",
  label: "Collected",
  location_id: "l1",
  latitude: null,
  longitude: null,
  planned_at: "2026-11-02T06:00:00Z",
  actual_at: "2026-11-02T07:00:00Z",
  exception_kind: null,
  note: null,
  recorded_at: "2026-11-02T07:05:00Z",
  sa_places: { name: "Johannesburg", latitude: "-26.204361", longitude: "28.041639" },
};

describe("mapCheckpoint", () => {
  it("falls back to the gazetteer place when the checkpoint has no pin", () => {
    const cp = mapCheckpoint(checkpointRow);
    expect(cp.latitude).toBe(-26.204361);
    expect(cp.longitude).toBe(28.041639);
    expect(cp.placeName).toBe("Johannesburg");
  });

  it("prefers the checkpoint's own pin over the place centre", () => {
    const cp = mapCheckpoint({
      ...checkpointRow,
      latitude: "-26.100000",
      longitude: "28.100000",
    });
    expect(cp.latitude).toBe(-26.1);
  });

  it("leaves coordinates null rather than inventing them", () => {
    // A checkpoint with no known position simply is not drawn. A route with
    // gaps beats a route with fabricated points.
    const cp = mapCheckpoint({ ...checkpointRow, sa_places: null });
    expect(cp.latitude).toBeNull();
    expect(cp.longitude).toBeNull();
    expect(cp.placeName).toBeNull();
  });
});

describe("mapLocationRow", () => {
  const base: LocationRow = {
    id: "l1",
    name: "Durban Depot",
    kind: "depot",
    latitude: null,
    longitude: null,
    archived_at: null,
    sa_places: { name: "Durban", latitude: "-29.858680", longitude: "31.021840" },
  };

  // The location's own pin wins over the town it sits in.
  it("prefers an exact pin and says so", () => {
    const point = mapLocationRow({ ...base, latitude: "-29.9", longitude: "31.1" });
    expect(point.latitude).toBe(-29.9);
    expect(point.coordinateSource).toBe("exact");
  });

  it("falls back to the town, and reports it as the town", () => {
    const point = mapLocationRow(base);
    expect(point.latitude).toBe(-29.85868);
    expect(point.coordinateSource).toBe("place");
    expect(point.placeName).toBe("Durban");
  });

  // NEVER 0,0. An unlocatable place reports that it has no position rather
  // than rendering in the Atlantic, which is the one thing this mapper must
  // not get wrong.
  it("reports no position rather than inventing one", () => {
    const point = mapLocationRow({ ...base, sa_places: null });
    expect(point.latitude).toBeNull();
    expect(point.longitude).toBeNull();
    expect(point.coordinateSource).toBe("unknown");
    expect(point.placeName).toBeNull();
  });

  // Postgres numerics arrive as strings through PostgREST.
  it("parses numerics that arrive as strings", () => {
    expect(typeof mapLocationRow(base).latitude).toBe("number");
  });
});

describe("mapLocationPoint", () => {
  const row: LocationPointRow = {
    location_id: "l1",
    name: "Alpha Depot",
    kind: "depot",
    effective_latitude: "-26.204361",
    effective_longitude: "28.041639",
    coordinate_source: "place",
    place_name: "Johannesburg",
  };

  it("carries the coordinate source through rather than hiding it", () => {
    // "approximate — town centre" is information the operator is entitled to.
    expect(mapLocationPoint(row).coordinateSource).toBe("place");
    expect(mapLocationPoint({ ...row, coordinate_source: "exact" }).coordinateSource).toBe(
      "exact"
    );
  });

  it("treats an unrecognised source as unknown", () => {
    // Schema drift must not render as a surveyed position.
    expect(
      mapLocationPoint({ ...row, coordinate_source: "something_new" }).coordinateSource
    ).toBe("unknown");
  });

  it("handles an unlocatable location", () => {
    const point = mapLocationPoint({
      ...row,
      effective_latitude: null,
      effective_longitude: null,
      coordinate_source: "unknown",
    });
    expect(point.latitude).toBeNull();
    expect(point.coordinateSource).toBe("unknown");
  });
});

const announcementRow: AnnouncementRow = {
  id: "a1",
  org_id: "o1",
  title: "Limited staff tomorrow",
  body: "Maintenance on the yard.",
  pinned: false,
  published_at: "2026-11-03T06:00:00Z",
  expires_at: null,
  retracted_at: null,
  posted_by: "u1",
};

describe("mapAnnouncement", () => {
  it("maps every field without leaving anything undefined", () => {
    for (const [key, value] of Object.entries(mapAnnouncement(announcementRow))) {
      expect(value, `${key} should not be undefined`).not.toBeUndefined();
    }
  });

  it("leaves expiry raw rather than deciding it here", () => {
    // Whether a notice has expired is a judgement against a clock, and this
    // layer has no clock. src/lib does that, with `now` passed in.
    const future = mapAnnouncement({ ...announcementRow, expires_at: "2027-01-01T00:00:00Z" });
    expect(future.expiresAt).toBe("2027-01-01T00:00:00Z");
  });
});

describe("mapMessage", () => {
  const messageRow: MessageRow = {
    id: "m1",
    org_id: "o1",
    shipment_id: "s1",
    counterparty_org_id: "o2",
    sender_org_id: "o2",
    sender_user_id: "u2",
    body: "Please confirm the delivery ETA.",
    retracted_at: null,
    created_at: "2026-11-03T08:00:00Z",
    shipments: { reference: "ALPHA-001" },
    organisations: { name: "Bravo Logistics" },
  };

  it("resolves the shipment reference and the sender's organisation", () => {
    const message = mapMessage(messageRow);
    expect(message.shipmentReference).toBe("ALPHA-001");
    expect(message.senderOrgName).toBe("Bravo Logistics");
  });

  it("copes with an organisation-wide message", () => {
    // No shipment and no counterparty is the broadcast case, not a bug.
    const message = mapMessage({
      ...messageRow,
      shipment_id: null,
      counterparty_org_id: null,
      shipments: null,
    });
    expect(message.shipmentId).toBeNull();
    expect(message.shipmentReference).toBeNull();
    expect(message.counterpartyOrgId).toBeNull();
  });
});

describe("mapTask", () => {
  const taskRow: TaskRow = {
    id: "t1",
    org_id: "o1",
    shipment_id: "s1",
    title: "Chase the Durban POD",
    detail: null,
    status: "open",
    priority: "high",
    due_at: "2026-11-05T14:00:00Z",
    assigned_to: "u3",
    completed_at: null,
    created_at: "2026-11-03T08:00:00Z",
    shipments: { reference: "ALPHA-001" },
  };

  it("maps the snake_case names the database actually uses", () => {
    const task = mapTask(taskRow);
    expect(task.assignedTo).toBe("u3");
    expect(task.dueAt).toBe("2026-11-05T14:00:00Z");
    expect(task.shipmentReference).toBe("ALPHA-001");
    expect(task.completedAt).toBeNull();
  });

  it("copes with a task that belongs to no shipment", () => {
    const task = mapTask({ ...taskRow, shipment_id: null, shipments: null });
    expect(task.shipmentId).toBeNull();
    expect(task.shipmentReference).toBeNull();
  });
});
