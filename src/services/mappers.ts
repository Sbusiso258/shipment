import type {
  Announcement,
  CheckpointException,
  CheckpointKind,
  JourneyCheckpoint,
  LocationPoint,
  Shipment,
  Message,
  ShipmentDirection,
  ShipmentStatus,
  Task,
  TaskPriority,
  TaskStatus,
  TransportMode,
} from "@/types/domain";

/**
 * snake_case rows in, camelCase domain objects out.
 *
 * Pure, and separated from the query functions on purpose: these are the most
 * boring code in the project and the easiest to get silently wrong. A
 * mistyped column name produces `undefined`, which renders as a blank cell
 * rather than an error — so it survives review, survives the build, and is
 * found by a customer.
 *
 * Being pure, they are unit-tested. That is the only cheap way to catch a
 * typo in a field name without a live database.
 */

export interface ShipmentRow {
  id: string;
  org_id: string;
  reference: string;
  direction: ShipmentDirection;
  mode: TransportMode;
  status: ShipmentStatus;
  origin_location_id: string;
  destination_location_id: string;
  carrier_name: string | null;
  driver_id: string | null;
  vehicle_id: string | null;
  vehicle_registration: string | null;
  driver_name: string | null;
  goods_description: string | null;
  cargo_value: string | number | null;
  currency: string;
  weight_kg: string | number | null;
  planned_dispatch_at: string | null;
  planned_delivery_at: string | null;
  promised_delivery_date: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  silence_threshold_days: number | null;
  last_event_at: string | null;
  checkpoint_count: number;
  cleared_checkpoint_count: number;
  notes: string | null;
  created_at: string;
}

/**
 * Postgres sends `numeric` as a STRING, deliberately — a float cannot hold
 * every decimal value exactly, and silently rounding money is how a refund
 * becomes revenue. It is converted here, at the boundary, and nowhere else.
 */
function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function mapShipment(row: ShipmentRow): Shipment {
  return {
    id: row.id,
    orgId: row.org_id,
    reference: row.reference,
    direction: row.direction,
    mode: row.mode,
    status: row.status,
    originLocationId: row.origin_location_id,
    destinationLocationId: row.destination_location_id,
    carrierName: row.carrier_name,
    driverId: row.driver_id,
    vehicleId: row.vehicle_id,
    vehicleRegistration: row.vehicle_registration,
    driverName: row.driver_name,
    goodsDescription: row.goods_description,
    // Null stays null. It means NOT DISCLOSED, and coercing it to 0 would
    // understate the board's value-at-risk figure without saying so.
    cargoValue: toNumber(row.cargo_value),
    currency: row.currency,
    weightKg: toNumber(row.weight_kg),
    plannedDispatchAt: row.planned_dispatch_at,
    plannedDeliveryAt: row.planned_delivery_at,
    promisedDeliveryDate: row.promised_delivery_date,
    dispatchedAt: row.dispatched_at,
    deliveredAt: row.delivered_at,
    cancelledAt: row.cancelled_at,
    silenceThresholdDays: row.silence_threshold_days,
    lastEventAt: row.last_event_at,
    checkpointCount: row.checkpoint_count,
    clearedCheckpointCount: row.cleared_checkpoint_count,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export interface CheckpointRow {
  id: string;
  shipment_id: string;
  sequence_no: number;
  kind: CheckpointKind;
  label: string;
  location_id: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
  planned_at: string | null;
  actual_at: string | null;
  exception_kind: CheckpointException | null;
  note: string | null;
  recorded_at: string | null;
  sa_places: { name: string; latitude: string | number; longitude: string | number } | null;
}

export function mapCheckpoint(row: CheckpointRow): JourneyCheckpoint {
  // A checkpoint's own pin wins; the gazetteer place is the fallback. Same
  // precedence as `location_points`, and never a guess: if neither exists the
  // checkpoint simply cannot be drawn.
  const latitude = toNumber(row.latitude) ?? toNumber(row.sa_places?.latitude ?? null);
  const longitude = toNumber(row.longitude) ?? toNumber(row.sa_places?.longitude ?? null);

  return {
    id: row.id,
    shipmentId: row.shipment_id,
    sequenceNo: row.sequence_no,
    kind: row.kind,
    label: row.label,
    locationId: row.location_id,
    latitude,
    longitude,
    placeName: row.sa_places?.name ?? null,
    plannedAt: row.planned_at,
    actualAt: row.actual_at,
    exceptionKind: row.exception_kind,
    note: row.note,
    recordedAt: row.recorded_at,
  };
}

export interface LocationPointRow {
  location_id: string;
  name: string;
  kind: string;
  effective_latitude: string | number | null;
  effective_longitude: string | number | null;
  coordinate_source: string;
  place_name: string | null;
}

/**
 * A `locations` row with its gazetteer entry embedded.
 *
 * WHY THIS EXISTS ALONGSIDE `LocationPointRow`. Reads used to go through the
 * `location_points` view, which did the coalescing in SQL. That view turned
 * out to be the single point of failure for every place in the product: in a
 * live project it had drifted into an ordinary empty table, so three separate
 * read paths returned nothing while the rows sat untouched in `locations`.
 *
 * Reading the base table and coalescing here removes that dependency
 * entirely. It is also the pattern `mapCheckpoint` already uses — same
 * embed, same precedence — so there is now one way this is done rather than
 * two.
 */
export interface LocationRow {
  id: string;
  name: string;
  kind: string;
  latitude: string | number | null;
  longitude: string | number | null;
  archived_at: string | null;
  sa_places: { name: string; latitude: string | number; longitude: string | number } | null;
}

export function mapLocationRow(row: LocationRow): LocationPoint {
  // The location's own pin wins; the town it sits in is the fallback. Exactly
  // the precedence the view encoded, and never a guess — with neither, the
  // place reports `unknown` rather than rendering as a point in the Atlantic.
  const exactLatitude = toNumber(row.latitude);
  const exactLongitude = toNumber(row.longitude);
  const placeLatitude = toNumber(row.sa_places?.latitude ?? null);
  const placeLongitude = toNumber(row.sa_places?.longitude ?? null);

  return {
    locationId: row.id,
    name: row.name,
    kind: row.kind,
    latitude: exactLatitude ?? placeLatitude,
    longitude: exactLongitude ?? placeLongitude,
    coordinateSource:
      exactLatitude !== null ? "exact" : placeLatitude !== null ? "place" : "unknown",
    placeName: row.sa_places?.name ?? null,
  };
}

export function mapLocationPoint(row: LocationPointRow): LocationPoint {
  return {
    locationId: row.location_id,
    name: row.name,
    kind: row.kind,
    latitude: toNumber(row.effective_latitude),
    longitude: toNumber(row.effective_longitude),
    // The view only ever returns these three. Anything else is a schema drift
    // worth surfacing rather than silently rendering as a surveyed position.
    coordinateSource:
      row.coordinate_source === "exact" || row.coordinate_source === "place"
        ? row.coordinate_source
        : "unknown",
    placeName: row.place_name,
  };
}

/* -------------------------------------------------------------------------
   Collaboration (0007)
   ------------------------------------------------------------------------- */

export interface AnnouncementRow {
  id: string;
  org_id: string;
  title: string;
  body: string;
  pinned: boolean;
  published_at: string;
  expires_at: string | null;
  retracted_at: string | null;
  posted_by: string;
}

export function mapAnnouncement(row: AnnouncementRow): Announcement {
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    body: row.body,
    pinned: row.pinned,
    publishedAt: row.published_at,
    // Left raw. Whether it has expired is a judgement against a clock, and
    // judgements live in src/lib where the clock is an argument.
    expiresAt: row.expires_at,
    retractedAt: row.retracted_at,
    postedBy: row.posted_by,
  };
}

export interface MessageRow {
  id: string;
  org_id: string;
  shipment_id: string | null;
  counterparty_org_id: string | null;
  sender_org_id: string;
  sender_user_id: string;
  body: string;
  retracted_at: string | null;
  created_at: string;
  shipments: { reference: string } | null;
  organisations: { name: string } | null;
}

export function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    orgId: row.org_id,
    shipmentId: row.shipment_id,
    shipmentReference: row.shipments?.reference ?? null,
    counterpartyOrgId: row.counterparty_org_id,
    senderOrgId: row.sender_org_id,
    senderOrgName: row.organisations?.name ?? null,
    senderUserId: row.sender_user_id,
    body: row.body,
    retractedAt: row.retracted_at,
    createdAt: row.created_at,
  };
}

export interface TaskRow {
  id: string;
  org_id: string;
  shipment_id: string | null;
  title: string;
  detail: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: string | null;
  assigned_to: string | null;
  completed_at: string | null;
  created_at: string;
  shipments: { reference: string } | null;
}

export function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    orgId: row.org_id,
    shipmentId: row.shipment_id,
    shipmentReference: row.shipments?.reference ?? null,
    title: row.title,
    detail: row.detail,
    status: row.status,
    priority: row.priority,
    dueAt: row.due_at,
    assignedTo: row.assigned_to,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}
