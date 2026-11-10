import type { LocationKind, LocationPoint } from "@/types/domain";

import { fail, logWriteFailure } from "./fail";
import { mapLocationRow, type LocationRow } from "./mappers";
import { supabaseServer } from "./supabase/server";

/**
 * The places an organisation ships from and to.
 *
 * Reads go to `locations` directly, with the gazetteer entry embedded, and
 * `mapLocationRow` coalesces an exact coordinate with the containing town's —
 * so a caller never has to decide which of the two to use, and the provenance
 * comes back with it as `coordinateSource`.
 *
 * THEY USED TO GO THROUGH THE `location_points` VIEW, and that is worth
 * remembering rather than quietly undoing. The view did the same coalescing in
 * SQL, which was tidier — right up to the day a live project was found holding
 * an ordinary empty table of that name instead. Three read paths went through
 * it, so the places list, the board's route lines and the journey map's
 * endpoints all returned nothing at once, while every row sat untouched in
 * `locations`. The product said "None yet" after nine depots had been saved.
 *
 * A table cannot drift into something else without the WRITE path failing
 * loudly first, which is the property the view lacked.
 *
 * Writes go to `locations`. No org filter and no role check here: RLS decides
 * what these return and whether they land.
 */

// READ THE BASE TABLE, not the `location_points` view.
//
// The view did the coalescing in SQL, and that made it the single point of
// failure for every place in the product: in a live project it had drifted
// into an ordinary empty table, so this read returned nothing while the rows
// sat untouched in `locations` — the places list showed "None yet" after nine
// depots had been saved, and /shipments/new refused because it counts them.
//
// Embedding the gazetteer and coalescing in `mapLocationRow` costs nothing
// and depends only on tables, which cannot drift into something else without
// the write path failing loudly first. `mapCheckpoint` already reads this
// way, so this is now one pattern rather than two.
const LOCATION_COLUMNS =
  "id, name, kind, latitude, longitude, archived_at, sa_places(name, latitude, longitude)";

export interface WriteResult {
  ok: boolean;
  error: string | null;
}

export interface LocationInput {
  name: string;
  kind: LocationKind;
  saPlaceId: string | null;
  addressLine: string | null;
  suburb: string | null;
  city: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
}

/**
 * Three check constraints guard a location, and all three have a reason worth
 * repeating to whoever tripped them. A constraint name is not an error message.
 */
function describe(message: string, fallback: string): string {
  if (message.includes("locations_coords_paired")) {
    return (
      "A coordinate needs both halves. One on its own renders as a point in " +
      "the Atlantic, so it is refused rather than stored."
    );
  }
  if (message.includes("locations_within_south_africa")) {
    return (
      "That coordinate is outside South Africa. Check the order — it is " +
      "latitude first, then longitude, and latitude is negative here."
    );
  }
  if (message.includes("locations_on_earth")) {
    return "That is not a valid coordinate.";
  }
  if (message.includes("locations_name_check")) {
    return "Give the place a name.";
  }
  if (message.includes("row-level security")) {
    return "Your role cannot change this organisation's places.";
  }
  return fallback;
}

/** Every location of the caller's organisation, with effective coordinates. */
export async function listLocations(
  includeArchived = false
): Promise<LocationPoint[]> {
  const supabase = await supabaseServer();

  let query = supabase
    .from("locations")
    .select(LOCATION_COLUMNS)
    .order("name", { ascending: true });

  if (!includeArchived) query = query.is("archived_at", null);

  const { data, error } = await query;

  if (error) fail("load locations", error);
  return ((data ?? []) as unknown as LocationRow[]).map(mapLocationRow);
}

export async function createLocation(
  input: LocationInput & { orgId: string }
): Promise<WriteResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the place a name." };

  // Half a coordinate is a constraint violation, but the person typing it
  // deserves to hear about it before the round trip.
  if ((input.latitude === null) !== (input.longitude === null)) {
    return {
      ok: false,
      error: "Enter both halves of the coordinate, or neither.",
    };
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.from("locations").insert({
    org_id: input.orgId,
    name,
    kind: input.kind,
    sa_place_id: input.saPlaceId,
    address_line: input.addressLine,
    suburb: input.suburb,
    city: input.city,
    postal_code: input.postalCode,
    latitude: input.latitude,
    longitude: input.longitude,
    notes: input.notes,
  });

  if (error) {
    logWriteFailure("create a place", error);
    return { ok: false, error: describe(error.message, "Could not save the place.") };
  }
  return { ok: true, error: null };
}

export async function updateLocation(
  locationId: string,
  input: LocationInput
): Promise<WriteResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the place a name." };

  if ((input.latitude === null) !== (input.longitude === null)) {
    return { ok: false, error: "Enter both halves of the coordinate, or neither." };
  }

  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("locations")
    .update({
      name,
      kind: input.kind,
      sa_place_id: input.saPlaceId,
      address_line: input.addressLine,
      suburb: input.suburb,
      city: input.city,
      postal_code: input.postalCode,
      latitude: input.latitude,
      longitude: input.longitude,
      notes: input.notes,
    })
    .eq("id", locationId)
    .select("id");

  if (error) {
    logWriteFailure("update a place", error);
    return { ok: false, error: describe(error.message, "Could not save the place.") };
  }

  // A `using` failure raises nothing — the update simply matches no rows.
  if (!data || data.length === 0) {
    return { ok: false, error: "That place is not yours to change." };
  }

  return { ok: true, error: null };
}

/**
 * Retire a place without deleting it.
 *
 * A delete would cascade nothing — `shipments` references locations by a
 * composite FK with no `on delete` clause, so Postgres would REFUSE while any
 * shipment still points at it. Archiving keeps every historical route
 * readable, which is the whole point of an oversight record, and keeps the
 * place out of the pickers.
 */
export async function setLocationArchived(
  locationId: string,
  archived: boolean
): Promise<WriteResult> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("locations")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", locationId)
    .select("id");

  if (error) {
    return { ok: false, error: describe(error.message, "Could not change the place.") };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: "That place is not yours to change." };
  }

  return { ok: true, error: null };
}
