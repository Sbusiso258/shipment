/**
 * Domain types.
 *
 * These are the shapes the rest of the app works in: camelCase, with the
 * database's snake_case rows mapped at the `src/services` boundary and never
 * escaping it. A component that receives a `Shipment` cannot tell which column
 * names the database uses, which is the point — the schema can be refactored
 * without touching the UI.
 *
 * Timestamps are ISO strings rather than `Date` objects. They cross the
 * server/client boundary in Next's serialisation, and a `Date` that survives
 * that round trip in one direction and not the other is a bug nobody enjoys.
 * Parsing happens where the maths happens, in `src/lib/journey.ts`.
 */

export type MembershipRole = "admin" | "operator" | "viewer";

export type ShipmentDirection = "inbound" | "outbound";

export type TransportMode = "road" | "rail" | "air" | "sea" | "multimodal";

export type ShipmentStatus =
  | "planned"
  | "in_transit"
  | "on_hold"
  | "delivered"
  | "cancelled";

export type CheckpointKind =
  | "pickup"
  | "depot_in"
  | "depot_out"
  | "linehaul"
  | "hub_scan"
  | "out_for_delivery"
  | "delivery"
  | "pod"
  | "exception"
  // Defined, never produced in V1. See 0004_shipments.sql.
  | "border_out"
  | "border_in"
  | "customs_hold"
  | "customs_clear";

export type CheckpointException =
  | "delay"
  | "breakdown"
  | "accident"
  | "damage"
  | "shortage"
  | "refused"
  | "rerouted"
  | "documentation"
  | "weather"
  | "other";

export type PartyRole =
  | "consignor"
  | "consignee"
  | "broker"
  | "carrier"
  | "insurer"
  | "notify_party"
  | "other";

/** Where a location's coordinates came from. Surfaced in the UI, not hidden. */
export type CoordinateSource = "exact" | "place" | "unknown";

/**
 * Mirrors the `location_kind` enum in 0002.
 *
 * `LocationPoint.kind` stays a plain string on purpose: it comes from a view
 * and is only ever displayed, so a value added by a future migration should
 * render rather than crash. This type is for the WRITE side, where naming a
 * kind the database does not have is a bug worth catching at compile time.
 */
/* -------------------------------------------------------------------------
   The fleet (0011)
   ------------------------------------------------------------------------- */

export type VehicleType =
  | "rigid"
  | "tractor"
  | "trailer"
  | "bakkie"
  | "van"
  | "other";

export interface Driver {
  id: string;
  orgId: string;
  fullName: string;
  phone: string | null;
  licenceNumber: string | null;
  licenceClass: string | null;
  /**
   * A calendar day (`YYYY-MM-DD`), not an instant — the second such column in
   * the schema after `promised_delivery_date`. A licence expires at the end
   * of a day in the operator's own zone.
   */
  licenceExpiry: string | null;
  notes: string | null;
  /** Retired rather than deleted; still named on the loads they carried. */
  archivedAt: string | null;
  createdAt: string;
}

export interface Vehicle {
  id: string;
  orgId: string;
  registration: string;
  make: string | null;
  model: string | null;
  vehicleType: VehicleType;
  /** Null means not recorded. Never 0 — see non-negotiable #9. */
  capacityKg: number | null;
  /** A calendar day, same reasoning as `licenceExpiry`. */
  serviceDue: string | null;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
}

/** Every operational decision 0012 records. */
export type DecisionAction =
  | "shipment_created"
  | "shipment_updated"
  | "shipment_dispatched"
  | "shipment_delivered"
  | "shipment_cancelled"
  | "shipment_held"
  | "shipment_resumed"
  | "operator_assigned"
  | "operator_withdrawn"
  | "party_granted"
  | "party_revoked"
  | "checkpoint_recorded"
  | "checkpoint_confirmed"
  | "exception_reported";

/**
 * One line of the audit trail.
 *
 * Written by triggers inside the transaction that made the change, never by
 * the application — there is deliberately no insert policy on the table, so
 * nothing here can be forged or tidied up afterwards.
 */
export interface DecisionLogEntry {
  id: string;
  orgId: string;

  /**
   * NULL means the change was made outside a user session — a migration, the
   * SQL editor, a batch job. "Somebody unknown" is true; naming an actor who
   * did not act would be a false line in an audit trail.
   */
  actorId: string | null;

  action: DecisionAction;
  subjectTable: string;
  subjectId: string;
  shipmentId: string | null;

  /** Only the columns that moved, each as `{ from, to }`. */
  changed: Record<string, { from: unknown; to: unknown }> | null;
  reason: string | null;
  createdAt: string;
}

export type LocationKind =
  | "depot"
  | "warehouse"
  | "customer_site"
  | "port"
  | "airport"
  | "yard"
  | "other";

export interface Organisation {
  id: string;
  name: string;
  slug: string;
  /** IANA zone. Every day boundary in this app resolves through it. */
  timezone: string;
  defaultSilenceThresholdDays: number;

  /**
   * WHICH PRODUCT THIS ORGANISATION GETS.
   *
   * True for a logistics business that records journeys — the paying
   * customer. False for a counterparty: a sender or recipient who raises
   * requests, files evidence and watches the loads shared with it, but never
   * records a journey of its own.
   *
   * The column has existed since `0001`, where it was defined for exactly
   * this ("a counterparty that only ever views shipments shared with it").
   * Nothing read it until the portal needed to decide which shell to render,
   * so this is a column finally being used rather than a new concept.
   */
  isSubscriber: boolean;
}

export interface LocationPoint {
  locationId: string;
  name: string;
  kind: string;
  latitude: number | null;
  longitude: number | null;
  /**
   * `place` means the coordinates are the centre of the containing town, not
   * the location itself. The interface says so rather than implying a surveyed
   * position.
   */
  coordinateSource: CoordinateSource;
  placeName: string | null;
}

export interface Shipment {
  id: string;
  orgId: string;
  reference: string;
  direction: ShipmentDirection;
  mode: TransportMode;
  status: ShipmentStatus;

  originLocationId: string;
  destinationLocationId: string;

  carrierName: string | null;

  /**
   * The fleet rows this load was given, where it was given fleet rows at all.
   *
   * Null is ordinary and means "not from our fleet" — subcontracted trucks and
   * hired-in drivers are normal in road freight, and a schema that insisted on
   * a `drivers` row for every load would make those shipments unrecordable.
   * The composite foreign keys `(driver_id, org_id)` and `(vehicle_id, org_id)`
   * are what stop one tenant naming another's truck.
   */
  driverId: string | null;
  vehicleId: string | null;

  /**
   * The text as it stood when the load was recorded.
   *
   * Not redundant beside the ids above. A driver is ARCHIVED rather than
   * deleted precisely so the loads they carried keep naming them, and these
   * two columns are also the only record for a load that never had a fleet row
   * — including every shipment entered before 0011 existed.
   */
  vehicleRegistration: string | null;
  driverName: string | null;

  goodsDescription: string | null;

  /** Null means NOT DISCLOSED. Never 0. */
  cargoValue: number | null;
  currency: string;
  weightKg: number | null;

  plannedDispatchAt: string | null;
  plannedDeliveryAt: string | null;

  /**
   * A calendar day (`YYYY-MM-DD`), not an instant — the commercial promise.
   * Lateness is judged against the END of this day in the organisation's
   * timezone.
   */
  promisedDeliveryDate: string | null;

  dispatchedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;

  /** Null means use the organisation's default. */
  silenceThresholdDays: number | null;

  lastEventAt: string | null;
  checkpointCount: number;
  clearedCheckpointCount: number;

  notes: string | null;
  createdAt: string;
}

export interface JourneyCheckpoint {
  id: string;
  shipmentId: string;
  sequenceNo: number;
  kind: CheckpointKind;
  label: string;

  locationId: string | null;
  latitude: number | null;
  longitude: number | null;
  placeName: string | null;

  plannedAt: string | null;
  /** Null means pending. The whole state machine turns on this. */
  actualAt: string | null;

  exceptionKind: CheckpointException | null;
  note: string | null;

  /** When the system was told, as against when it happened. */
  recordedAt: string | null;
}

export interface ShipmentParty {
  id: string;
  shipmentId: string;
  partyOrgId: string;
  partyOrgName: string;
  partyRole: PartyRole;
  revokedAt: string | null;
}

/* -------------------------------------------------------------------------
   Collaboration — announcements, messages and tasks (0007)
   ------------------------------------------------------------------------- */

export interface Announcement {
  id: string;
  orgId: string;
  title: string;
  body: string;
  pinned: boolean;
  publishedAt: string;
  /** Null means it never expires. Expiry is judged in `src/lib`, not the database. */
  expiresAt: string | null;
  retractedAt: string | null;
  postedBy: string;
}

export interface Message {
  id: string;
  orgId: string;
  /** Null means an organisation-wide internal message. */
  shipmentId: string | null;
  shipmentReference: string | null;
  /** Null means internal; set means a two-party channel with that organisation. */
  counterpartyOrgId: string | null;
  senderOrgId: string;
  senderOrgName: string | null;
  senderUserId: string;
  body: string;
  retractedAt: string | null;
  createdAt: string;
}

export type TaskStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface Task {
  id: string;
  orgId: string;
  shipmentId: string | null;
  shipmentReference: string | null;
  title: string;
  detail: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  /** An instant, not a day — only `promisedDeliveryDate` is day-scoped. */
  dueAt: string | null;
  assignedTo: string | null;
  completedAt: string | null;
  createdAt: string;
}
