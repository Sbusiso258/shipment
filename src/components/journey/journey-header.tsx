import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";

import { formatDays } from "@/lib/duration";
import type { JourneyState } from "@/lib/journey";
import type { LocationPoint, Shipment } from "@/types/domain";

import { VerdictBadge } from "./verdict-badge";

function day(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  return format(new TZDate(new Date(iso).getTime(), timeZone), "EEE d MMM");
}

export function JourneyHeader({
  shipment,
  summary,
  origin,
  destination,
  timeZone,
}: {
  shipment: Shipment;
  summary: JourneyState;
  origin: LocationPoint | null;
  destination: LocationPoint | null;
  timeZone: string;
}) {
  const detail =
    summary.lateByDays !== null
      ? formatDays(summary.lateByDays)
      : summary.silentForDays !== null
        ? formatDays(summary.silentForDays)
        : null;

  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-code text-micro uppercase tracking-widest text-marine-500">
            {shipment.direction} · {shipment.mode}
          </p>
          <h1 className="font-code text-title font-semibold text-ink-950">
            {shipment.reference}
          </h1>
          <p className="mt-1 text-ink-600">
            {origin?.name ?? "Unknown origin"}
            <span aria-hidden className="mx-2 text-ink-400">
              →
            </span>
            {destination?.name ?? "Unknown destination"}
          </p>
        </div>

        <VerdictBadge verdict={summary.verdict} detail={detail} />
      </div>

      {/* The promise line. Planned and actual side by side so slippage is read
          rather than calculated in someone's head. */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-panel border border-ink-200 bg-paper p-4 shadow-panel sm:grid-cols-4">
        <div>
          <dt className="text-micro uppercase tracking-wide text-ink-400">Promised</dt>
          <dd className="font-code text-body text-ink-950">
            {shipment.promisedDeliveryDate
              ? format(
                  new TZDate(
                    new Date(`${shipment.promisedDeliveryDate}T12:00:00Z`).getTime(),
                    timeZone
                  ),
                  "EEE d MMM"
                )
              : // Never a guessed commitment.
                "Not promised"}
          </dd>
        </div>

        <div>
          <dt className="text-micro uppercase tracking-wide text-ink-400">
            {shipment.deliveredAt ? "Delivered" : "Expected"}
          </dt>
          <dd className="font-code text-body text-ink-950">
            {day(shipment.deliveredAt, timeZone) ??
              day(shipment.plannedDeliveryAt, timeZone) ??
              "No ETA"}
          </dd>
        </div>

        <div>
          <dt className="text-micro uppercase tracking-wide text-ink-400">Progress</dt>
          <dd className="font-code text-body text-ink-950">
            {summary.progress.cleared} of {summary.progress.total}
          </dd>
        </div>

        <div>
          <dt className="text-micro uppercase tracking-wide text-ink-400">Carrier</dt>
          <dd className="text-body text-ink-950">
            {shipment.carrierName ?? <span className="text-ink-400">Not recorded</span>}
          </dd>
        </div>
      </dl>

      {/* Silence has nothing on the timeline to colour — which is exactly why
          a design that only styles rows misses it. It gets its own strip. */}
      {summary.silentForDays !== null ? (
        <p className="rounded-control bg-silent-bg px-3 py-2 text-small text-silent">
          No update logged in {formatDays(summary.silentForDays)}.
        </p>
      ) : null}
    </header>
  );
}
