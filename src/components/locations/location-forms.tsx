"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { GazetteerPlace } from "@/services/checkpoints";
import type { LocationKind } from "@/types/domain";

import {
  EMPTY_FORM_STATE,
  type LocationFormState,
} from "./location-form-state";

/**
 * Adding a place.
 *
 * THE COORDINATE FIELD IS A PASTE BOX, NOT A SEARCH BOX, and the difference
 * is a product rule rather than a shortcut. There is no geocoding in this
 * product: a coordinate comes from the seeded gazetteer, from somebody
 * pasting a real pin, or from clicking the map. A field that turned
 * "12 Smith Street" into a position would be inventing one, and a
 * plausible-looking wrong pin is worse than no pin because nobody checks a
 * pin that looks right.
 *
 * So the town picker is the normal path and sets the coordinate to the town's
 * centre, labelled as such everywhere it is drawn. The paste box is the
 * upgrade, for when somebody has actually stood there.
 */

type Action = (prev: LocationFormState, form: FormData) => Promise<LocationFormState>;

const KINDS: [LocationKind, string][] = [
  ["depot", "Depot"],
  ["warehouse", "Warehouse"],
  ["customer_site", "Customer site"],
  ["port", "Port"],
  ["airport", "Airport"],
  ["yard", "Yard"],
  ["other", "Other"],
];

export interface LocationDefaults {
  name: string;
  kind: LocationKind;
  saPlaceId: string | null;
  addressLine: string | null;
  suburb: string | null;
  city: string | null;
  postalCode: string | null;
  coordinates: string;
  notes: string | null;
}

function Status({ state, success }: { state: LocationFormState; success: string }) {
  if (state.error) {
    return (
      <p
        role="alert"
        className="rounded-control bg-exception-bg px-3 py-2 text-small text-exception"
      >
        {state.error}
      </p>
    );
  }
  if (state.ok) {
    return (
      <p
        role="status"
        className="rounded-control bg-ontime-bg px-3 py-2 text-small text-ontime"
      >
        {success}
      </p>
    );
  }
  return null;
}

const SELECT =
  "h-10 w-full rounded-control border border-ink-200 bg-paper px-3 text-body text-ink-950";

export function LocationForm({
  action,
  places,
  defaults,
  submitLabel = "Add place",
  successMessage = "Saved.",
}: {
  action: Action;
  places: GazetteerPlace[];
  defaults?: LocationDefaults;
  submitLabel?: string;
  successMessage?: string;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY_FORM_STATE);

  // WHAT THE BOXES SHOULD SAY. After a rejected submission the action hands
  // back what was typed, and that wins over `defaults` — otherwise React 19's
  // automatic form reset throws the lot away and the person retypes
  // everything to see the same error again.
  const kept = state.values;
  const shown = (field: keyof LocationDefaults, fallback?: string) =>
    kept?.[field] ?? fallback;

  return (
    // KEYED ON THE ATTEMPT. `defaultValue` is read once, at mount, so handing
    // back the values is not enough on its own — the form has to remount for
    // React to look at them again.
    <form key={state.attempt ?? 0} action={submit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="loc-name">Name</Label>
          <Input
            id="loc-name"
            name="name"
            required
            defaultValue={shown("name", defaults?.name)}
            placeholder="Johannesburg Depot"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="loc-kind">Kind</Label>
          <select
            id="loc-kind"
            name="kind"
            defaultValue={shown("kind", defaults?.kind ?? "depot")}
            className={SELECT}
          >
            {KINDS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="loc-place">Town</Label>
        <select
          id="loc-place"
          name="saPlaceId"
          defaultValue={shown("saPlaceId", defaults?.saPlaceId ?? "")}
          className={SELECT}
        >
          <option value="">Not set</option>
          {places.map((place) => (
            <option key={place.id} value={place.id}>
              {place.name}
            </option>
          ))}
        </select>
        <p className="text-micro text-ink-400">
          Where this place sits. Used to put it on the map when no exact
          coordinate is given — and the journey says so rather than implying a
          surveyed position.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="loc-address">Street address</Label>
          <Input
            id="loc-address"
            name="addressLine"
            defaultValue={shown("addressLine", defaults?.addressLine ?? "")}
            placeholder="14 Director Road, Spartan"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="loc-coordinates">Exact coordinate</Label>
          <Input
            id="loc-coordinates"
            name="coordinates"
            inputMode="text"
            defaultValue={shown("coordinates", defaults?.coordinates ?? "")}
            placeholder="-29.8587, 31.0218"
            className="font-code"
          />
          <p className="text-micro text-ink-400">
            Optional. Paste a pin from a phone — latitude first, then
            longitude. Nothing is looked up from the address.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="loc-suburb">Suburb</Label>
          <Input id="loc-suburb" name="suburb" defaultValue={shown("suburb", defaults?.suburb ?? "")} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="loc-city">City</Label>
          <Input id="loc-city" name="city" defaultValue={shown("city", defaults?.city ?? "")} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="loc-postal">Postal code</Label>
          <Input
            id="loc-postal"
            name="postalCode"
            defaultValue={shown("postalCode", defaults?.postalCode ?? "")}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="loc-notes">Notes</Label>
        <Input
          id="loc-notes"
          name="notes"
          defaultValue={shown("notes", defaults?.notes ?? "")}
          placeholder="Gate 3. Deliveries 06:00–16:00."
        />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>

      <Status state={state} success={successMessage} />
    </form>
  );
}

/** Retires a place without deleting it, so historical routes still read. */
export function ArchiveLocationButton({
  locationId,
  archived,
  action,
}: {
  locationId: string;
  archived: boolean;
  action: Action;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY_FORM_STATE);

  return (
    <form action={submit} className="flex items-center gap-2">
      <input type="hidden" name="locationId" value={locationId} />
      <input type="hidden" name="archived" value={archived ? "false" : "true"} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "Saving…" : archived ? "Restore" : "Retire"}
      </Button>
      {state.error ? (
        <span role="alert" className="text-micro text-exception">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
