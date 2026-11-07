import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ShipmentForm } from "@/components/shipments/shipment-form";
import { dateTimeLocalIn } from "@/lib/date";
import { canEditShipments } from "@/lib/roles";
import { requireSession } from "@/services/bootstrap";
import { loadPlaces } from "@/services/checkpoints";
import { listDrivers, listVehicles } from "@/services/fleet";
import { listLocations } from "@/services/locations";
import { loadJourney } from "@/services/shipments";

import { updateShipmentAction } from "../actions";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const journey = await loadJourney(id);
  return { title: journey ? `Edit ${journey.shipment.reference}` : "Edit shipment" };
}

/**
 * `datetime-local` wants `YYYY-MM-DDTHH:mm` with no zone.
 *
 * Rendered from the instant on the SERVER, in UTC, which is wrong by the
 * operator's offset — so the field is hydrated in the browser instead. Doing
 * it here would show a South African operator a time two hours earlier than
 * the one they entered.
 */
function emptyIfNull(value: string | null): string {
  return value ?? "";
}

export default async function EditShipmentPage({ params }: Params) {
  const { id } = await params;
  const session = await requireSession();

  if (!canEditShipments(session.activeRole)) notFound();

  const journey = await loadJourney(id);

  // RLS returns nothing rather than refusing, so a shipment this user may not
  // see is indistinguishable from one that does not exist. Under 0008 that
  // covers an operator who is not assigned to it.
  if (!journey) notFound();

  // ARCHIVED ROWS INCLUDED HERE, and labelled in the picker. This load may
  // already name a driver who has since left, and a picker that silently
  // dropped them would blank the field on the next save — rewriting who
  // carried the load as a side effect of editing its weight.
  const [locations, places, drivers, vehicles] = await Promise.all([
    listLocations(),
    loadPlaces(),
    listDrivers(true),
    listVehicles(true),
  ]);

  const { shipment } = journey;

  // The id is bound HERE, on the server. A server action is a public
  // endpoint, so an id travelling through the form would be an id the client
  // could change.
  const save = updateShipmentAction.bind(null, shipment.id);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-6">
      <header>
        <Link
          href={`/shipments/${shipment.id}`}
          className="text-small text-ink-600 hover:text-ink-950"
        >
          ← {shipment.reference}
        </Link>
        <h1 className="mt-2 text-title font-semibold text-ink-950">
          Edit shipment
        </h1>
        <p className="mt-1 text-ink-600">
          Dispatch, delivery and cancellation are not here — they are on the
          shipment itself, because they are events rather than corrections.
        </p>
      </header>

      <section className="rounded-panel border border-ink-200 bg-paper-raised p-panel shadow-panel">
        <ShipmentForm
          action={save}
          locations={locations}
          places={places}
          drivers={drivers}
          vehicles={vehicles}
          submitLabel="Save changes"
          successMessage="Saved."
          defaults={{
            reference: shipment.reference,
            direction: shipment.direction,
            mode: shipment.mode,
            originLocationId: shipment.originLocationId,
            destinationLocationId: shipment.destinationLocationId,
            carrierName: emptyIfNull(shipment.carrierName),
            driverId: emptyIfNull(shipment.driverId),
            vehicleId: emptyIfNull(shipment.vehicleId),
            vehicleRegistration: emptyIfNull(shipment.vehicleRegistration),
            driverName: emptyIfNull(shipment.driverName),
            goodsDescription: emptyIfNull(shipment.goodsDescription),
            // Null stays an empty box. Rendering 0 here would turn "not
            // disclosed" into "worthless" the first time somebody saved.
            cargoValue: shipment.cargoValue === null ? "" : String(shipment.cargoValue),
            weightKg: shipment.weightKg === null ? "" : String(shipment.weightKg),
            // IN THE ORGANISATION'S ZONE, not the server's. These two were
            // hardcoded to "" — the inputs rendered blank but still posted, so
            // saving any edit wiped both planned times, the board's ETA
            // included. A blank field on a form that posts is a deletion.
            plannedDispatchAt: shipment.plannedDispatchAt
              ? dateTimeLocalIn(new Date(shipment.plannedDispatchAt), session.activeOrg.timezone)
              : "",
            plannedDeliveryAt: shipment.plannedDeliveryAt
              ? dateTimeLocalIn(new Date(shipment.plannedDeliveryAt), session.activeOrg.timezone)
              : "",
            promisedDeliveryDate: emptyIfNull(shipment.promisedDeliveryDate),
            silenceThresholdDays:
              shipment.silenceThresholdDays === null
                ? ""
                : String(shipment.silenceThresholdDays),
            notes: emptyIfNull(shipment.notes),
          }}
        />
      </section>

      {/* Said plainly, because an empty field that clears a stored value is
          the kind of thing people discover after it has happened. */}
      <p className="text-small text-ink-600">
        The two planned times start empty. Fill them in to set them; leaving
        them blank clears whatever is stored.
      </p>
    </main>
  );
}
