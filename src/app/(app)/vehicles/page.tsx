import type { Metadata } from "next";

import {
  ArchiveFleetButton,
  VehicleForm,
} from "@/components/fleet/fleet-forms";
import { canManageLocations } from "@/lib/roles";
import { requireSession } from "@/services/bootstrap";
import { listVehicles } from "@/services/fleet";
import type { VehicleType } from "@/types/domain";

import { archiveVehicleAction, createVehicleAction } from "./actions";

export const metadata: Metadata = { title: "Vehicles" };

const TYPE_LABEL: Record<VehicleType, string> = {
  rigid: "Rigid truck",
  tractor: "Tractor unit",
  trailer: "Trailer",
  bakkie: "Bakkie",
  van: "Van",
  other: "Vehicle",
};

export default async function VehiclesPage() {
  const session = await requireSession();
  const mayManage = canManageLocations(session.activeRole);

  const vehicles = await listVehicles(true);
  const live = vehicles.filter((v) => v.archivedAt === null);
  const retired = vehicles.filter((v) => v.archivedAt !== null);

  // The organisation's own day. A service due today is not overdue.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: session.activeOrg.timezone,
  }).format(new Date());

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 py-6">
      <header>
        <h1 className="text-title font-semibold text-ink-950">Vehicles</h1>
        <p className="mt-1 text-ink-600">
          {session.activeOrg.name}&rsquo;s fleet. A vehicle you retire stays on
          the loads it carried.
        </p>
      </header>

      <section className="rounded-panel border border-ink-200 bg-paper-raised shadow-panel">
        <header className="border-b border-ink-200 px-panel py-3">
          <h2 className="text-lead font-medium text-ink-950">
            {live.length} {live.length === 1 ? "vehicle" : "vehicles"}
          </h2>
        </header>

        {live.length === 0 ? (
          <p className="px-4 py-10 text-center text-ink-600">
            None yet. Add the first one below, then pick it when you record a
            shipment.
          </p>
        ) : (
          <ul>
            {live.map((vehicle) => {
              const overdue =
                vehicle.serviceDue !== null && vehicle.serviceDue < today;

              return (
                <li
                  key={vehicle.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-panel py-3 last:border-b-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-code text-body font-medium text-ink-950">
                      {vehicle.registration}
                    </span>
                    <span className="block truncate text-micro text-ink-400">
                      {TYPE_LABEL[vehicle.vehicleType]}
                      {vehicle.make ? ` · ${vehicle.make}` : null}
                      {vehicle.model ? ` ${vehicle.model}` : null}
                      {vehicle.capacityKg !== null
                        ? ` · ${vehicle.capacityKg.toLocaleString("en-ZA")} kg`
                        : null}
                    </span>
                  </span>

                  <span className="flex items-center gap-3 text-small">
                    {overdue ? (
                      <span className="rounded-control bg-late-bg px-2 py-0.5 text-late">
                        Service overdue
                      </span>
                    ) : null}
                    {mayManage ? (
                      <ArchiveFleetButton
                        name="vehicleId"
                        id={vehicle.id}
                        archived={false}
                        action={archiveVehicleAction}
                      />
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {retired.length > 0 ? (
        <details className="rounded-panel border border-ink-200 bg-paper-raised p-panel text-small">
          <summary className="cursor-pointer text-ink-600">
            {retired.length} retired
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {retired.map((vehicle) => (
              <li key={vehicle.id} className="flex items-center justify-between gap-3">
                <span className="truncate font-code text-ink-400">
                  {vehicle.registration}
                </span>
                {mayManage ? (
                  <ArchiveFleetButton
                    name="vehicleId"
                    id={vehicle.id}
                    archived
                    action={archiveVehicleAction}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {mayManage ? (
        <section className="rounded-panel border border-ink-200 bg-paper-raised p-panel shadow-panel">
          <h2 className="text-lead font-medium text-ink-950">Add a vehicle</h2>
          <p className="mb-3 mt-1 text-small text-ink-600">
            Only the registration is required. It is matched ignoring spaces
            and punctuation, so one plate cannot become two vehicles.
          </p>
          <VehicleForm action={createVehicleAction} />
        </section>
      ) : null}
    </main>
  );
}
