"use server";

import { revalidatePath } from "next/cache";

import { canManageLocations } from "@/lib/roles";
import { requireSession } from "@/services/bootstrap";
import {
  createLocation,
  setLocationArchived,
  updateLocation,
  type LocationInput,
} from "@/services/locations";
import type { LocationKind } from "@/types/domain";

/**
 * The places a shipment runs between.
 *
 * Each action re-establishes who is asking: a server action is a public HTTP
 * endpoint, invocable directly, so the screen's role check protects the
 * screen and not this. RLS refuses the write regardless — the check here is
 * for the MESSAGE.
 */

export type { LocationFormState } from "@/components/locations/location-form-state";

import type { LocationFormState } from "@/components/locations/location-form-state";
import { submittedValues } from "@/lib/form-values";

function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A pasted pin, as a phone's share sheet writes it.
 *
 * Accepts `-29.8587, 31.0218` and the same thing with a space, a tab or no
 * separator at all beyond whitespace. It does NOT accept an address — there
 * is no geocoding in this product, and a field that silently looked one up
 * would be inventing a coordinate.
 *
 * Returns `undefined` when the text is unparseable, which the caller reports,
 * rather than null, which means "deliberately empty".
 */
function parseCoordinates(
  text: string | null
): { latitude: number; longitude: number } | null | undefined {
  if (!text) return null;

  const parts = text
    .replace(/[()]/g, "")
    .split(/[\s,]+/)
    .filter(Boolean);

  if (parts.length !== 2) return undefined;

  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  return { latitude, longitude };
}

/**
 * An explicit union, not an inferred one. Two `return`s with different shapes
 * infer a single object with optional properties, which type-checks at the
 * call site and then hands `undefined` to the service.
 */
type ReadResult =
  | { ok: false; error: string }
  | { ok: true; input: LocationInput };

function readInput(form: FormData): ReadResult {
  const coordinates = parseCoordinates(field(form, "coordinates"));

  if (coordinates === undefined) {
    return {
      ok: false,
      error:
        "That coordinate could not be read. Paste it as two numbers: " +
        "-29.8587, 31.0218",
    };
  }

  return {
    ok: true,
    input: {
      name: field(form, "name") ?? "",
      kind: (field(form, "kind") ?? "other") as LocationKind,
      saPlaceId: field(form, "saPlaceId"),
      addressLine: field(form, "addressLine"),
      suburb: field(form, "suburb"),
      city: field(form, "city"),
      postalCode: field(form, "postalCode"),
      latitude: coordinates?.latitude ?? null,
      longitude: coordinates?.longitude ?? null,
      notes: field(form, "notes"),
    },
  };
}

export async function createLocationAction(
  _prev: LocationFormState,
  form: FormData
): Promise<LocationFormState> {
  const session = await requireSession();

  // EVERY FAILURE PATH HANDS THE TYPING BACK. Returning a bare
  // `{ ok: false, error }` is what made a rejected submission erase the form.
  const failed = (error: string): LocationFormState => ({
    ok: false,
    error,
    values: submittedValues(form),
    attempt: (_prev.attempt ?? 0) + 1,
  });

  if (!canManageLocations(session.activeRole)) {
    return failed("Your role cannot add places.");
  }

  const read = readInput(form);
  if (!read.ok) return failed(read.error);

  const result = await createLocation({ ...read.input, orgId: session.activeOrg.id });
  if (!result.ok) return failed(result.error ?? "Could not save the place.");

  revalidatePath("/locations");

  // Nothing carried back on success: the form SHOULD clear, and a bumped
  // `attempt` is what remounts it empty.
  return { ok: true, error: null, attempt: (_prev.attempt ?? 0) + 1 };
}

export async function updateLocationAction(
  locationId: string,
  _prev: LocationFormState,
  form: FormData
): Promise<LocationFormState> {
  const session = await requireSession();

  if (!canManageLocations(session.activeRole)) {
    return { ok: false, error: "Your role cannot change places." };
  }

  const read = readInput(form);
  if (!read.ok) return { ok: false, error: read.error };

  const result = await updateLocation(locationId, read.input);
  if (!result.ok) return result;

  revalidatePath("/locations");
  // A renamed depot shows on every board row and journey that uses it.
  revalidatePath("/", "layout");
  return { ok: true, error: null };
}

export async function archiveLocationAction(
  _prev: LocationFormState,
  form: FormData
): Promise<LocationFormState> {
  const session = await requireSession();

  if (!canManageLocations(session.activeRole)) {
    return { ok: false, error: "Your role cannot change places." };
  }

  const locationId = field(form, "locationId");
  if (!locationId) return { ok: false, error: "No place was selected." };

  const result = await setLocationArchived(
    locationId,
    form.get("archived") !== "false"
  );
  if (!result.ok) return result;

  revalidatePath("/locations");
  return { ok: true, error: null };
}
