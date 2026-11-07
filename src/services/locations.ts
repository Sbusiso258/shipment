import type { LocationKind, LocationPoint } from "@/types/domain";

import { fail } from "./fail";
import { mapLocationPoint, type LocationPointRow } from "./mappers";
import { supabaseServer } from "./supabase/server";

/**
 * The places an organisation ships from and to.
 *
 * Reads go through `location_points`, the view that coalesces an exact
 * coordinate with the containing town's — so a caller never has to decide
 * which of the two to use, and the provenance comes back with it as
 * `coordinateSource`. The view is `security_invoker`, so it leaks no more than
 * the table.
 *
 * Writes go to `locations`. No org filter and no role check here: RLS decides
 * what these return and whether they land.
 */

const LOCATION_POINT_COLUMNS =
  "location_id, name, kind, effective_latitude, effective_longitude, coordinate_source, place_name";

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
    .from("location_points")
    .select(LOCATION_POINT_COLUMNS)
    .order("name", { ascending: true });

  if (!includeArchived) query = query.is("archived_at", null);

  const { data, error } = await query;

  if (error) fail("load locations", error);
  return ((data ?? []) as unknown as LocationPointRow[]).map(mapLocationPoint);
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

  if (error) return { ok: false, error: describe(error.message, "Could not save the place.") };
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

  if (error) return { ok: false, error: describe(error.message, "Could not save the place.") };

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
