import type { Metadata } from "next";
import Link from "next/link";

import {
  ArchiveLocationButton,
  LocationForm,
} from "@/components/locations/location-forms";
import { canManageLocations } from "@/lib/roles";
import { requireSession } from "@/services/bootstrap";
import { loadPlaces } from "@/services/checkpoints";
import { orNoticed } from "@/services/fail";
import { listLocations } from "@/services/locations";

import { archiveLocationAction, createLocationAction } from "./actions";

export const metadata: Metadata = { title: "Places" };

const SOURCE_LABEL: Record<string, string> = {
  exact: "Exact pin",
  place: "Town centre",
  unknown: "No position",
};

/**
 * The depots, yards and customer sites a shipment runs between.
 *
 * This screen exists because a shipment cannot be created without two of
 * them, and until now there was no way to make one outside the seed file.
 */
export default async function LocationsPage() {
  const session = await requireSession();
  const mayManage = canManageLocations(session.activeRole);

  // The gazetteer is only needed by the form, so a viewer never pays for it.
  // THE LIST IS THE POINT OF THIS PAGE. The gazetteer only feeds the
  // "add a place" picker, so a database behind on `sa_places` should cost the
  // picker its options — not hide every depot the operator already has. It hid
  // all of them, because a `Promise.all` rejects if either side does.
  const [locations, placesResult] = await Promise.all([
    listLocations(),
    orNoticed(
      mayManage ? loadPlaces() : Promise.resolve([]),
      [] as Awaited<ReturnType<typeof loadPlaces>>
    ),
  ]);

  const places = placesResult.value;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-title font-semibold text-ink-950">Places</h1>
          <p className="mt-1 text-ink-600">
            Where {session.activeOrg.name} collects and delivers. A shipment
            needs two of these.
          </p>
        </div>
        <Link href="/" className="text-small text-ink-600 hover:text-ink-950">
          ← Board
        </Link>
      </header>

      <section className="rounded-panel border border-ink-200 bg-paper-raised shadow-panel">
        <header className="border-b border-ink-200 px-panel py-3">
          <h2 className="text-lead font-medium text-ink-950">
            {locations.length} {locations.length === 1 ? "place" : "places"}
          </h2>
        </header>

        {locations.length === 0 ? (
          <p className="px-4 py-10 text-center text-ink-600">
            None yet. Add the first one below — a depot you load from, and the
            customer site you deliver to.
          </p>
        ) : (
          <ol>
            {locations.map((place) => (
              <li
                key={place.locationId}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-panel py-3 last:border-b-0"
              >
                <span className="min-w-0">
                  <span className="block truncate text-body font-medium text-ink-950">
                    {place.name}
                  </span>
                  <span className="block truncate text-micro text-ink-400">
                    {place.kind.replace(/_/g, " ")}
                    {place.placeName ? ` · ${place.placeName}` : null}
                  </span>
                </span>

                <span className="flex items-center gap-3 text-small">
                  {/* Provenance, never hidden. "Town centre" is a different
                      claim from "exact pin", and the difference matters when
                      somebody is deciding whether to trust the map. */}
                  <span
                    className={
                      place.coordinateSource === "exact"
                        ? "rounded-control bg-ontime-bg px-2 py-0.5 text-ontime"
                        : place.coordinateSource === "place"
                          ? "rounded-control bg-ink-100 px-2 py-0.5 text-ink-600"
                          : "rounded-control bg-late-bg px-2 py-0.5 text-late"
                    }
                  >
                    {SOURCE_LABEL[place.coordinateSource]}
                  </span>

                  {mayManage ? (
                    <ArchiveLocationButton
                      locationId={place.locationId}
                      archived={false}
                      action={archiveLocationAction}
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* A viewer is shown no form. Not because hiding it secures anything —
          RLS refuses the write regardless — but because offering somebody a
          form that always fails is a lie. */}
      {mayManage ? (
        <section className="rounded-panel border border-ink-200 bg-paper-raised p-panel shadow-panel">
          <h2 className="text-lead font-medium text-ink-950">Add a place</h2>
          <p className="mb-3 mt-1 text-small text-ink-600">
            Pick the town it sits in. Add an exact coordinate only if you have a
            real one — nothing here is looked up from an address.
          </p>
          {placesResult.notice ? (
            <p
              role="status"
              className="mb-3 rounded-control bg-late-bg px-3 py-2 text-small whitespace-pre-wrap text-late"
            >
              {placesResult.notice}
            </p>
          ) : null}
          <LocationForm action={createLocationAction} places={places} />
        </section>
      ) : null}
    </main>
  );
}
