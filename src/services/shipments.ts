import type { BoardRow } from "@/lib/board";
import { verdictFor, type JourneyClock } from "@/lib/journey";
import type {
  JourneyCheckpoint,
  LocationPoint,
  Shipment,
  ShipmentDirection,
  TransportMode,
} from "@/types/domain";

import { cache } from "react";

import { fail } from "./fail";
import {
  mapCheckpoint,
  mapLocationPoint,
  mapShipment,
  type CheckpointRow,
  type LocationPointRow,
  type ShipmentRow,
} from "./mappers";
import { supabaseServer } from "./supabase/server";

/**
 * The only code that reads shipments from the database.
 *
 * Note what is NOT here: any filtering by organisation. RLS decides what these
 * queries return. Adding `.eq("org_id", …)` would look like defence in depth
 * and would actually be a liability — it would hide a broken policy during
 * testing, so the day somebody removed the filter the leak would be live.
 * The policies are the boundary; `verify:rls` proves they hold.
 */

/** Literal, for PostgREST's type inference. See the note in bootstrap.ts. */
const SHIPMENT_COLUMNS =
  "id, org_id, reference, direction, mode, status, origin_location_id, destination_location_id, carrier_name, driver_id, vehicle_id, vehicle_registration, driver_name, goods_description, cargo_value, currency, weight_kg, planned_dispatch_at, planned_delivery_at, promised_delivery_date, dispatched_at, delivered_at, cancelled_at, silence_threshold_days, last_event_at, checkpoint_count, cleared_checkpoint_count, notes, created_at";

const CHECKPOINT_COLUMNS =
  "id, shipment_id, sequence_no, kind, label, location_id, latitude, longitude, planned_at, actual_at, exception_kind, note, recorded_at, sa_places(name, latitude, longitude)";

const LOCATION_POINT_COLUMNS =
  "location_id, name, kind, effective_latitude, effective_longitude, coordinate_source, place_name";

/**
 * Postgres raises `invalid input syntax for type uuid` when a non-uuid is
 * compared to a uuid column, which surfaced as a 500 on `/shipments/<junk>`.
 *
 * A malformed id is not an error, it is simply not a shipment — and a 500
 * both tells the visitor the wrong thing and hands them a stack trace in
 * development. Checking the shape first turns it into the 404 it always was.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BoardData {
  rows: BoardRow[];
}

/**
 * Everything the oversight board needs, in three queries rather than one per
 * shipment.
 *
 * The board needs a verdict per shipment, and two of the verdict's inputs
 * depend on checkpoints. Loading every checkpoint of every shipment to get
 * them would be absurd, so each is fetched as its own small indexed query:
 * the set of shipments with an open exception, and the set whose next
 * expected stage is already overdue.
 */
export async function loadBoard(clock: JourneyClock): Promise<BoardData> {
  const supabase = await supabaseServer();

  const { data: shipmentData, error: shipmentError } = await supabase
    .from("shipments")
    .select(SHIPMENT_COLUMNS)
    .order("created_at", { ascending: false });

  if (shipmentError) fail("load shipments", shipmentError);

  const shipments = ((shipmentData ?? []) as unknown as ShipmentRow[]).map(mapShipment);
  if (shipments.length === 0) return { rows: [] };

  const ids = shipments.map((s) => s.id);

  // Uses `checkpoints_exception_idx`.
  const { data: exceptionData, error: exceptionError } = await supabase
    .from("checkpoints")
    .select("shipment_id")
    .in("shipment_id", ids)
    .not("exception_kind", "is", null);

  if (exceptionError) fail("load exceptions", exceptionError);

  const withException = new Set(
    ((exceptionData ?? []) as { shipment_id: string }[]).map((r) => r.shipment_id)
  );

  // Uses `checkpoints_pending_idx`. A stage planned before now and not yet
  // confirmed is the earliest honest warning that a promise is in trouble.
  const { data: overdueData, error: overdueError } = await supabase
    .from("checkpoints")
    .select("shipment_id")
    .in("shipment_id", ids)
    .is("actual_at", null)
    .lt("planned_at", clock.now.toISOString());

  if (overdueError) fail("load overdue stages", overdueError);

  const withOverdue = new Set(
    ((overdueData ?? []) as { shipment_id: string }[]).map((r) => r.shipment_id)
  );

  // Endpoint names, for the row's route line.
  const locationIds = [
    ...new Set(shipments.flatMap((s) => [s.originLocationId, s.destinationLocationId])),
  ];

  const { data: locationData, error: locationError } = await supabase
    .from("location_points")
    .select(LOCATION_POINT_COLUMNS)
    .in("location_id", locationIds);

  if (locationError) fail("load locations", locationError);

  const locations = new Map(
    ((locationData ?? []) as unknown as LocationPointRow[])
      .map(mapLocationPoint)
      .map((point) => [point.locationId, point])
  );

  const rows: BoardRow[] = shipments.map((shipment) => ({
    shipment,
    verdict: verdictFor(
      shipment,
      {
        hasException: withException.has(shipment.id),
        nextExpectedOverdue: withOverdue.has(shipment.id),
      },
      {
        ...clock,
        silenceThresholdDays:
          shipment.silenceThresholdDays ?? clock.silenceThresholdDays,
      }
    ),
    // Deliberately not "in transit": nothing has been confirmed, and naming a
    // position we were not told is the one thing this product must never do.
    currentLabel: null,
    originName: locations.get(shipment.originLocationId)?.name ?? "Unknown origin",
    destinationName:
      locations.get(shipment.destinationLocationId)?.name ?? "Unknown destination",
    // The same rows the names came from — the coordinates were already
    // fetched and were simply being dropped.
    originPoint: locations.get(shipment.originLocationId) ?? null,
    destinationPoint: locations.get(shipment.destinationLocationId) ?? null,
  }));

  return { rows };
}

export interface JourneyData {
  shipment: Shipment;
  checkpoints: JourneyCheckpoint[];
  origin: LocationPoint | null;
  destination: LocationPoint | null;
}

/** One shipment and its whole journey. Null when RLS says it does not exist. */
/**
 * MEMOISED PER REQUEST, because every shipment page calls it twice.
 *
 * `generateMetadata` needs the reference for the <title> and the page body
 * needs the whole journey, and Next runs them as separate calls — so the
 * detail page was issuing six queries for one view and the edit page ten.
 * `cache()` keys on the argument, and the argument is one string, so the
 * second call returns the first call's promise.
 *
 * Per REQUEST only. Two users, or the same user refreshing, each pay once —
 * which is correct: a journey that was cached across requests would show a
 * stale position after somebody confirmed a stage.
 */
export const loadJourney = cache(_loadJourney);

async function _loadJourney(shipmentId: string): Promise<JourneyData | null> {
  if (!UUID.test(shipmentId)) return null;

  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("shipments")
    .select(SHIPMENT_COLUMNS)
    .eq("id", shipmentId)
    .maybeSingle();

  if (error) fail("load shipment", error);
  // RLS returns nothing rather than refusing, so "not permitted" and "does not
  // exist" are indistinguishable here — which is the correct behaviour. A 404
  // does not confirm that a shipment exists to someone who may not see it.
  if (!data) return null;

  const shipment = mapShipment(data as unknown as ShipmentRow);

  const { data: checkpointData, error: checkpointError } = await supabase
    .from("checkpoints")
    .select(CHECKPOINT_COLUMNS)
    .eq("shipment_id", shipmentId)
    .order("sequence_no", { ascending: true });

  if (checkpointError) fail("load checkpoints", checkpointError);

  const checkpoints = ((checkpointData ?? []) as unknown as CheckpointRow[]).map(
    mapCheckpoint
  );

  const { data: locationData, error: locationError } = await supabase
    .from("location_points")
    .select(LOCATION_POINT_COLUMNS)
    .in("location_id", [shipment.originLocationId, shipment.destinationLocationId]);

  if (locationError) fail("load endpoints", locationError);

  const points = ((locationData ?? []) as unknown as LocationPointRow[]).map(
    mapLocationPoint
  );

  return {
    shipment,
    checkpoints,
    origin: points.find((p) => p.locationId === shipment.originLocationId) ?? null,
    destination:
      points.find((p) => p.locationId === shipment.destinationLocationId) ?? null,
  };
}

/* ------------------------------------------------------------------------ */
/* Writes                                                                     */
/* ------------------------------------------------------------------------ */

export interface WriteResult {
  ok: boolean;
  error: string | null;
}

export interface ShipmentInput {
  reference: string;
  direction: ShipmentDirection;
  mode: TransportMode;
  originLocationId: string;
  destinationLocationId: string;
  carrierName: string | null;

  /**
   * A fleet row, or null for a truck or driver that is not ours.
   *
   * When one IS given, the service resolves its name itself and writes the
   * text columns below from the fleet row. It deliberately does not take that
   * text from the caller: a display name posted alongside an id is a second
   * version of the same fact, supplied by the browser, and the one that is
   * wrong goes into the permanent record.
   */
  driverId: string | null;
  vehicleId: string | null;

  /** Used only when no fleet row is given — a subcontracted truck or driver. */
  vehicleRegistration: string | null;
  driverName: string | null;

  goodsDescription: string | null;
  /** NULL means not disclosed. Never 0 — see non-negotiable #9. */
  cargoValue: number | null;
  weightKg: number | null;
  plannedDispatchAt: string | null;
  plannedDeliveryAt: string | null;
  /** A calendar day, `YYYY-MM-DD`. The only `date` in the schema. */
  promisedDeliveryDate: string | null;
  silenceThresholdDays: number | null;
  notes: string | null;
}

/**
 * Constraint names are not error messages. Each of these is a rule somebody
 * can act on, so each gets a sentence.
 */
function describeWrite(message: string, fallback: string): string {
  if (message.includes("shipments_org_reference_idx")) {
    return "A shipment with that reference already exists.";
  }
  if (message.includes("shipments_distinct_endpoints")) {
    return "A shipment has to go somewhere. Pick a different destination.";
  }
  if (message.includes("shipments_origin_fkey") || message.includes("shipments_destination_fkey")) {
    // The composite FK is (id, org_id), so this also fires for another
    // tenant's depot — which is the leak it exists to prevent.
    return "That place does not belong to this organisation.";
  }
  if (message.includes("shipments_reference_check")) {
    return "Give the shipment a reference.";
  }
  if (message.includes("shipments_driver_fkey")) {
    return "That driver does not belong to this organisation.";
  }
  if (message.includes("shipments_vehicle_fkey")) {
    return "That vehicle does not belong to this organisation.";
  }
  if (message.includes("shipments_delivery_after_dispatch")) {
    return "A shipment cannot be delivered before it was dispatched.";
  }
  if (message.includes("cargo_value")) {
    return "A cargo value cannot be negative. Leave it blank if it is not disclosed.";
  }
  if (message.includes("weight_kg")) {
    return "A weight has to be greater than zero. Leave it blank if unknown.";
  }
  if (message.includes("silence_threshold")) {
    return "The silence threshold has to be between 1 and 30 days.";
  }
  if (message.includes("row-level security")) {
    return "Your role cannot do that to this shipment.";
  }
  return fallback;
}

/**
 * The text to file against a load, given what the operator chose.
 *
 * A fleet row wins, and its name is read from the fleet row rather than taken
 * from the form. The form could have posted the name next to the id, and it
 * would have been one fewer query — but then the permanent record of who
 * drove a load would be a string the browser sent, and the day the two
 * disagree is the day the audit trail becomes an opinion.
 *
 * Reading them costs nothing extra in safety terms either: RLS applies, so a
 * driver id belonging to another tenant resolves to no row here and is
 * refused again by the composite foreign key on insert.
 */
async function resolveFleetText(
  input: ShipmentInput
): Promise<{ driverName: string | null; vehicleRegistration: string | null }> {
  if (!input.driverId && !input.vehicleId) {
    return {
      driverName: input.driverName,
      vehicleRegistration: input.vehicleRegistration,
    };
  }

  const supabase = await supabaseServer();

  const [driver, vehicle] = await Promise.all([
    input.driverId
      ? supabase.from("drivers").select("full_name").eq("id", input.driverId).maybeSingle()
      : Promise.resolve({ data: null }),
    input.vehicleId
      ? supabase.from("vehicles").select("registration").eq("id", input.vehicleId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    // Falling back to the typed text matters on an EDIT: if a fleet row has
    // since been archived out of view, overwriting the stored name with null
    // would erase the only record of who carried the load.
    driverName: driver.data?.full_name ?? input.driverName,
    vehicleRegistration: vehicle.data?.registration ?? input.vehicleRegistration,
  };
}

/** The column payload both writes share. */
function toRow(
  input: ShipmentInput,
  text: { driverName: string | null; vehicleRegistration: string | null }
) {
  return {
    reference: input.reference.trim(),
    direction: input.direction,
    mode: input.mode,
    origin_location_id: input.originLocationId,
    destination_location_id: input.destinationLocationId,
    carrier_name: input.carrierName,
    driver_id: input.driverId,
    vehicle_id: input.vehicleId,
    vehicle_registration: text.vehicleRegistration,
    driver_name: text.driverName,
    goods_description: input.goodsDescription,
    cargo_value: input.cargoValue,
    weight_kg: input.weightKg,
    planned_dispatch_at: input.plannedDispatchAt,
    planned_delivery_at: input.plannedDeliveryAt,
    promised_delivery_date: input.promisedDeliveryDate,
    silence_threshold_days: input.silenceThresholdDays,
    notes: input.notes,
  };
}

/**
 * Record a new shipment.
 *
 * `status` is deliberately absent. `shipments_sync_status` derives it from
 * `dispatched_at` and `delivered_at`; a status written here could disagree
 * with the timestamps, and then two parts of the product would be telling the
 * customer different things.
 */
export async function createShipment(
  input: ShipmentInput & { orgId: string; createdBy: string }
): Promise<{ ok: boolean; shipmentId: string | null; error: string | null }> {
  if (!input.reference.trim()) {
    return { ok: false, shipmentId: null, error: "Give the shipment a reference." };
  }
  if (!input.originLocationId || !input.destinationLocationId) {
    return { ok: false, shipmentId: null, error: "Pick where it starts and where it ends." };
  }

  const supabase = await supabaseServer();

  const text = await resolveFleetText(input);

  const { data, error } = await supabase
    .from("shipments")
    .insert({ ...toRow(input, text), org_id: input.orgId, created_by: input.createdBy })
    .select("id")
    .single();

  if (error || !data) {
    return {
      ok: false,
      shipmentId: null,
      error: describeWrite(error?.message ?? "", "Could not save the shipment."),
    };
  }

  return { ok: true, shipmentId: data.id, error: null };
}

export async function updateShipment(
  shipmentId: string,
  input: ShipmentInput
): Promise<WriteResult> {
  if (!input.reference.trim()) {
    return { ok: false, error: "Give the shipment a reference." };
  }

  const supabase = await supabaseServer();

  const text = await resolveFleetText(input);

  const { data, error } = await supabase
    .from("shipments")
    .update(toRow(input, text))
    .eq("id", shipmentId)
    .select("id");

  if (error) {
    return { ok: false, error: describeWrite(error.message, "Could not save the shipment.") };
  }
  // A `using` failure raises nothing — the update simply matches no rows.
  // Under 0008 that is what an operator sees for a shipment they are not on.
  if (!data || data.length === 0) {
    return { ok: false, error: "That shipment is not yours to change." };
  }

  return { ok: true, error: null };
}

/**
 * Move a shipment through its lifecycle.
 *
 * TIMESTAMPS, NOT STATUS — except for `on_hold`. `shipments_sync_status`
 * derives `in_transit` from `dispatched_at` and `delivered` from
 * `delivered_at`, so writing the status directly would let the form and the
 * trigger disagree. Nothing derives `on_hold`: it is a human assertion that a
 * load has stopped, so it is the one value written as a status.
 */
export type LifecycleEvent =
  | "dispatch"
  | "deliver"
  | "hold"
  | "resume"
  | "cancel";

export async function applyLifecycleEvent(
  shipmentId: string,
  event: LifecycleEvent,
  at: string
): Promise<WriteResult> {
  const patch: Record<string, string | null> = {
    dispatch: { dispatched_at: at },
    deliver: { delivered_at: at },
    cancel: { cancelled_at: at, status: "cancelled" },
    hold: { status: "on_hold" },
    // Back to planned; the trigger lifts it to in_transit if it has left.
    resume: { status: "planned" },
  }[event];

  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("shipments")
    .update(patch)
    .eq("id", shipmentId)
    .select("id");

  if (error) {
    return { ok: false, error: describeWrite(error.message, "Could not update the shipment.") };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: "That shipment is not yours to change." };
  }

  return { ok: true, error: null };
}
