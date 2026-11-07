import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ShipmentForm } from "@/components/shipments/shipment-form";
import { Button } from "@/components/ui/button";
import { canEditShipments } from "@/lib/roles";
import { requireSession } from "@/services/bootstrap";
import { loadPlaces } from "@/services/checkpoints";
import { listDrivers, listVehicles } from "@/services/fleet";
import { listLocations } from "@/services/locations";

import { createShipmentAction } from "./actions";

export const metadata: Metadata = { title: "New shipment" };

export default async function NewShipmentPage() {
  const session = await requireSession();

  // notFound(), not a redirect: a viewer has no business here and a redirect
  // would confirm the route exists.
  if (!canEditShipments(session.activeRole)) notFound();

  // Live fleet rows only. An archived driver is one who has left; offering
  // them for a NEW load would be inviting a mistake, where showing them on an
  // EDIT is just reporting what the load already says.
  const [locations, places, drivers, vehicles] = await Promise.all([
    listLocations(),
    loadPlaces(),
    listDrivers(),
    listVehicles(),
  ]);

  // Two distinct places are a hard requirement — `shipments_distinct_endpoints`
  // and two NOT NULL columns. An empty form here would only fail on submit.
  if (locations.length < 2) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-4 py-6">
        <header>
          <Link href="/" className="text-small text-ink-600 hover:text-ink-950">
            ← Board
          </Link>
          <h1 className="mt-2 text-title font-semibold text-ink-950">
            New shipment
          </h1>
        </header>

        <div className="rounded-panel border border-dashed border-ink-200 px-4 py-10 text-center">
          <p className="text-ink-800">
            A shipment runs between two places, and{" "}
            {locations.length === 0
              ? "none have been added yet"
              : "only one has been added so far"}
            .
          </p>
          <p className="mt-1 text-small text-ink-600">
            Add a depot to collect from and a site to deliver to, then come back.
          </p>
          <Button asChild className="mt-4">
            <Link href="/locations">Add places</Link>
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-6">
      <header>
        <Link href="/" className="text-small text-ink-600 hover:text-ink-950">
          ← Board
        </Link>
        <h1 className="mt-2 text-title font-semibold text-ink-950">
          New shipment
        </h1>
        <p className="mt-1 text-ink-600">
          What is moving, where it is going, and the route you expect it to
          take. Only the reference and the two places are required.
        </p>
      </header>

      <section className="rounded-panel border border-ink-200 bg-paper-raised p-panel shadow-panel">
        <ShipmentForm
          action={createShipmentAction}
          locations={locations}
          places={places}
          drivers={drivers}
          vehicles={vehicles}
          withStages
          submitLabel="Record shipment"
          successMessage="Recorded. It is on the board now."
        />
      </section>
    </main>
  );
}
