import type { Metadata } from "next";

import {
  ArchiveFleetButton,
  DriverForm,
} from "@/components/fleet/fleet-forms";
import { canManageLocations } from "@/lib/roles";
import { requireSession } from "@/services/bootstrap";
import { listDrivers } from "@/services/fleet";

import { archiveDriverAction, createDriverAction } from "./actions";

export const metadata: Metadata = { title: "Drivers" };

/** `YYYY-MM-DD` compared as text — no zone is involved, so none is invented. */
function expiryState(expiry: string | null, today: string) {
  if (!expiry) return null;
  if (expiry < today) return { tone: "exception", label: "Licence expired" };
  return null;
}

export default async function DriversPage() {
  const session = await requireSession();
  const mayManage = canManageLocations(session.activeRole);

  const drivers = await listDrivers(true);
  const live = drivers.filter((d) => d.archivedAt === null);
  const retired = drivers.filter((d) => d.archivedAt !== null);

  // The organisation's own day, not the server's. A licence that expires
  // today has not expired yet.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: session.activeOrg.timezone,
  }).format(new Date());

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 py-6">
      <header>
        <h1 className="text-title font-semibold text-ink-950">Drivers</h1>
        <p className="mt-1 text-ink-600">
          The people {session.activeOrg.name} puts behind a wheel. A driver you
          retire stays on the loads they carried.
        </p>
      </header>

      <section className="rounded-panel border border-ink-200 bg-paper-raised shadow-panel">
        <header className="border-b border-ink-200 px-panel py-3">
          <h2 className="text-lead font-medium text-ink-950">
            {live.length} {live.length === 1 ? "driver" : "drivers"}
          </h2>
        </header>

        {live.length === 0 ? (
          <p className="px-4 py-10 text-center text-ink-600">
            None yet. Add the first one below, then pick them when you record a
            shipment.
          </p>
        ) : (
          <ul>
            {live.map((driver) => {
              const expired = expiryState(driver.licenceExpiry, today);
              return (
                <li
                  key={driver.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-panel py-3 last:border-b-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-body font-medium text-ink-950">
                      {driver.fullName}
                    </span>
                    <span className="block truncate text-micro text-ink-400">
                      {driver.phone ?? "No phone"}
                      {driver.licenceClass ? ` · Class ${driver.licenceClass}` : null}
                      {driver.licenceExpiry ? ` · expires ${driver.licenceExpiry}` : null}
                    </span>
                  </span>

                  <span className="flex items-center gap-3 text-small">
                    {expired ? (
                      <span className="rounded-control bg-exception-bg px-2 py-0.5 text-exception">
                        {expired.label}
                      </span>
                    ) : null}
                    {mayManage ? (
                      <ArchiveFleetButton
                        name="driverId"
                        id={driver.id}
                        archived={false}
                        action={archiveDriverAction}
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
            {retired.map((driver) => (
              <li key={driver.id} className="flex items-center justify-between gap-3">
                <span className="truncate text-ink-400">{driver.fullName}</span>
                {mayManage ? (
                  <ArchiveFleetButton
                    name="driverId"
                    id={driver.id}
                    archived
                    action={archiveDriverAction}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* A viewer is shown no form. Not because hiding it secures anything —
          RLS refuses the write regardless — but because offering somebody a
          form that always fails is a lie. */}
      {mayManage ? (
        <section className="rounded-panel border border-ink-200 bg-paper-raised p-panel shadow-panel">
          <h2 className="text-lead font-medium text-ink-950">Add a driver</h2>
          <p className="mb-3 mt-1 text-small text-ink-600">
            Only the name is required. The licence details are for your own
            records — nothing outside this organisation ever sees them.
          </p>
          <DriverForm action={createDriverAction} />
        </section>
      ) : null}
    </main>
  );
}
