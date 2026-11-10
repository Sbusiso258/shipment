import type { Metadata } from "next";

import {
  activityBy,
  exceptionsByKind,
  onTimeReport,
  volumeByRoute,
} from "@/lib/reports";
import { loadRecentCheckpoints } from "@/services/activity";
import { orNoticed } from "@/services/fail";
import { requireSession } from "@/services/bootstrap";
import { loadOversight, requestNow } from "@/services/oversight";

export const metadata: Metadata = { title: "Reports" };

const EXCEPTION_LABEL: Record<string, string> = {
  breakdown: "Breakdown",
  delay: "Delay",
  damage: "Damage",
  theft: "Theft",
  road_closure: "Road closure",
  customs_hold: "Customs hold",
  refused: "Refused",
  other: "Other",
};

function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-panel border border-ink-200 bg-paper-raised shadow-panel">
      <header className="border-b border-ink-200 px-panel py-3">
        <h2 className="text-lead font-medium text-ink-950">{title}</h2>
        {note ? <p className="mt-0.5 text-micro text-ink-400">{note}</p> : null}
      </header>
      {children}
    </section>
  );
}

function Rows({
  rows,
  empty,
}: {
  rows: { key: string; label: string; value: string }[];
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="px-4 py-8 text-center text-small text-ink-400">{empty}</p>;
  }
  return (
    <ul>
      {rows.map((row) => (
        <li
          key={row.key}
          className="flex items-center justify-between gap-3 border-b border-ink-100 px-panel py-2.5 last:border-b-0"
        >
          <span className="min-w-0 truncate text-small text-ink-950">{row.label}</span>
          <span className="shrink-0 font-code text-small text-ink-600">{row.value}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function ReportsPage() {
  const session = await requireSession();
  const nowMs = requestNow();

  // Checkpoints feed ONE of the five panels — the exception breakdown. The
  // other four come from the board, so a database behind on a checkpoint
  // column should cost that panel and not the on-time rate, the routes, the
  // drivers and the vehicles alongside it.
  const [{ rows }, checkpointsResult] = await Promise.all([
    loadOversight(
      nowMs,
      session.activeOrg.timezone,
      session.activeOrg.defaultSilenceThresholdDays
    ),
    orNoticed(
      loadRecentCheckpoints(200),
      [] as Awaited<ReturnType<typeof loadRecentCheckpoints>>
    ),
  ]);

  const checkpoints = checkpointsResult.value;

  const shipments = rows.map((row) => row.shipment);
  const onTime = onTimeReport(shipments, session.activeOrg.timezone);
  const exceptions = exceptionsByKind(checkpoints);
  const routes = volumeByRoute(rows);
  const drivers = activityBy(rows, (s) => s.driverName);
  const vehicles = activityBy(rows, (s) => s.vehicleRegistration);

  return (
    <main className="mx-auto flex w-full max-w-[90rem] flex-1 flex-col gap-5 px-4 py-6">
      <header>
        <h1 className="text-title font-semibold text-ink-950">Reports</h1>
        <p className="mt-1 text-ink-600">
          Everything here is counted from what was actually recorded for{" "}
          {session.activeOrg.name}. Nothing is estimated.
        </p>
      </header>

      {/* --- on time ------------------------------------------------------ */}
      <Panel
        title="On-time delivery"
        note={`Judged against the end of the promised day in ${session.activeOrg.timezone}.`}
      >
        <div className="grid gap-px bg-ink-200 sm:grid-cols-4">
          <figure className="bg-paper-raised p-panel">
            <figcaption className="text-micro text-ink-400">On-time rate</figcaption>
            {/* Null, not 0%. "Nothing delivered yet" and "none arrived on
                time" are different facts and must not look the same. */}
            <p className="font-code text-display font-semibold leading-none text-ink-950">
              {onTime.rate === null ? "—" : `${onTime.rate}%`}
            </p>
          </figure>
          <figure className="bg-paper-raised p-panel">
            <figcaption className="text-micro text-ink-400">On time</figcaption>
            <p className="font-code text-title font-semibold leading-none text-ontime">
              {onTime.onTime}
            </p>
          </figure>
          <figure className="bg-paper-raised p-panel">
            <figcaption className="text-micro text-ink-400">Late</figcaption>
            <p className="font-code text-title font-semibold leading-none text-late">
              {onTime.late}
            </p>
          </figure>
          <figure className="bg-paper-raised p-panel">
            <figcaption className="text-micro text-ink-400">No promise made</figcaption>
            <p className="font-code text-title font-semibold leading-none text-ink-400">
              {onTime.unjudgeable}
            </p>
          </figure>
        </div>

        {/* The excluded rows, said out loud. A denominator that quietly drops
            rows is how a 98% appears that nobody can reproduce. */}
        {onTime.unjudgeable > 0 ? (
          <p className="border-t border-ink-100 px-panel py-2 text-micro text-ink-400">
            {onTime.unjudgeable}{" "}
            {onTime.unjudgeable === 1 ? "delivery is" : "deliveries are"} left out
            of the rate: no promised date was recorded, so there is nothing to
            judge them against.
          </p>
        ) : null}
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* --- exceptions ------------------------------------------------- */}
        <Panel title="Exceptions" note="Every problem reported at a stage.">
          {/* "Nothing has gone wrong yet" is a strong claim, and it is the
              default empty state below. A failed read must not borrow it. */}
          {checkpointsResult.notice ? (
            <p
              role="status"
              className="rounded-control bg-late-bg px-3 py-2 text-small whitespace-pre-wrap text-late"
            >
              {checkpointsResult.notice}
            </p>
          ) : null}
          <Rows
            empty="Nothing has gone wrong yet."
            rows={exceptions.map((e) => ({
              key: e.kind,
              label: EXCEPTION_LABEL[e.kind] ?? e.kind,
              value: String(e.count),
            }))}
          />
        </Panel>

        {/* --- routes ------------------------------------------------------ */}
        <Panel title="Volume by route" note="Loads run on each corridor.">
          <Rows
            empty="No shipments yet."
            rows={routes.map((r) => ({
              key: r.route,
              label: r.route,
              value: `${r.count} · ${r.delivered} delivered`,
            }))}
          />
        </Panel>

        {/* --- drivers ------------------------------------------------------ */}
        <Panel
          title="Driver activity"
          note="Loads carried. Not distance — nothing records road distance, and a straight line between stages would be an estimate dressed as a fact."
        >
          <Rows
            empty="No driver has been named on a shipment yet."
            rows={drivers.map((d) => ({
              key: d.name,
              label: d.name,
              value: `${d.loads} · ${d.delivered} delivered`,
            }))}
          />
        </Panel>

        {/* --- vehicles ----------------------------------------------------- */}
        <Panel title="Vehicle activity" note="Loads carried, per registration.">
          <Rows
            empty="No vehicle has been named on a shipment yet."
            rows={vehicles.map((v) => ({
              key: v.name,
              label: v.name,
              value: `${v.loads} · ${v.delivered} delivered`,
            }))}
          />
        </Panel>
      </div>
    </main>
  );
}
