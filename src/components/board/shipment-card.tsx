import Link from "next/link";
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { Plane, Ship, Train, Truck } from "lucide-react";

import type { BoardRow } from "@/lib/board";
import type { JourneyClock, ShipmentVerdict } from "@/lib/journey";
import { cn } from "@/lib/utils";
import type { TransportMode } from "@/types/domain";

/**
 * One shipment, as a card.
 *
 * Laid out to the owner's reference: reference code, destination as the
 * headline, a mode glyph, then a recessed panel of four facts beside a large
 * completion figure.
 *
 * THE BAR SHOWS PROGRESS; ITS COLOUR SHOWS HEALTH. In the reference the bar
 * colours look decorative — a red 90% beside a green 30%. Here they mean
 * something: a shipment can be 90% of the way through its stages and still be
 * red because it is in trouble. Progress and health are different questions,
 * and the card answers both without a second control.
 */

const MODE_ICON: Record<TransportMode, typeof Truck> = {
  road: Truck,
  rail: Train,
  air: Plane,
  sea: Ship,
  multimodal: Truck,
};

const MODE_LABEL: Record<TransportMode, string> = {
  road: "Road freight",
  rail: "Rail freight",
  air: "Air freight",
  sea: "Sea freight",
  multimodal: "Multimodal",
};

/** The bar takes the verdict's colour, so it reads the same as the badges. */
const VERDICT_BAR: Record<ShipmentVerdict, string> = {
  exception: "bg-exception",
  late: "bg-late",
  at_risk: "bg-late",
  silent: "bg-silent",
  on_track: "bg-ontime",
  delivered: "bg-delivered",
  delivered_late: "bg-late",
  cancelled: "bg-ink-400",
};

const VERDICT_TEXT: Record<ShipmentVerdict, string> = {
  exception: "text-exception",
  late: "text-late",
  at_risk: "text-late",
  silent: "text-silent",
  on_track: "text-ontime",
  delivered: "text-delivered",
  delivered_late: "text-late",
  cancelled: "text-ink-400",
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-micro text-ink-400">{label}</dt>
      <dd className="truncate text-small text-ink-950">{children}</dd>
    </div>
  );
}

export function ShipmentCard({
  row,
  clock,
  href,
}: {
  row: BoardRow;
  clock: JourneyClock;
  href: string;
}) {
  const { shipment } = row;
  const ModeIcon = MODE_ICON[shipment.mode] ?? Truck;

  const when = (iso: string | null, pattern: string) =>
    iso ? format(new TZDate(new Date(iso).getTime(), clock.timeZone), pattern) : null;

  const departed = when(shipment.dispatchedAt, "EEE d MMM, HH:mm");

  const arrival =
    when(shipment.deliveredAt, "EEE, d MMM yyyy") ??
    when(shipment.plannedDeliveryAt, "EEE, d MMM yyyy") ??
    (shipment.promisedDeliveryDate
      ? format(
          new TZDate(
            new Date(`${shipment.promisedDeliveryDate}T12:00:00Z`).getTime(),
            clock.timeZone
          ),
          "EEE, d MMM yyyy"
        )
      : null);

  const percent =
    shipment.checkpointCount > 0
      ? Math.round((shipment.clearedCheckpointCount / shipment.checkpointCount) * 100)
      : 0;

  return (
    <li>
      <Link
        href={href}
        className={cn(
          "flex h-full flex-col gap-3 rounded-panel border border-ink-200 bg-paper-raised p-panel",
          "transition-colors hover:border-marine-500"
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-code text-small text-marine-200">{shipment.reference}</p>
            <h3 className="truncate text-lead font-semibold text-ink-950">
              {row.destinationName}
            </h3>
            <p className="mt-0.5 text-micro text-ink-400">
              {departed ? `Departed ${departed}` : "Not yet dispatched"}
            </p>
          </div>

          {/* A glyph, not an illustration. We have no picture of this vehicle,
              and a generic one implies we do. */}
          <ModeIcon
            aria-hidden
            className="size-10 shrink-0 text-marine-200 opacity-70"
            strokeWidth={1.25}
          />
        </div>

        <div className="mt-auto flex items-end gap-3 rounded-panel bg-canvas/70 p-3">
          <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-3 gap-y-2">
            <Fact label="Stages done">
              <span className="font-code">
                {shipment.clearedCheckpointCount}
                <span className="text-ink-400">/{shipment.checkpointCount}</span>
              </span>
            </Fact>

            <Fact label="Vehicle">
              {shipment.vehicleRegistration ?? (
                <span className="text-ink-400">Not recorded</span>
              )}
            </Fact>

            <Fact label={shipment.deliveredAt ? "Delivered" : "Estimated arrival"}>
              {arrival ?? <span className="text-ink-400">No date</span>}
            </Fact>

            <Fact label="Method">{MODE_LABEL[shipment.mode] ?? shipment.mode}</Fact>
          </dl>

          <div className="flex shrink-0 flex-col items-end gap-2">
            <span
              className={cn(
                "font-code text-title font-semibold leading-none",
                VERDICT_TEXT[row.verdict]
              )}
            >
              {percent}%
            </span>
            <span
              className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-200"
              role="img"
              aria-label={`${percent}% of stages complete`}
            >
              <span
                className={cn("block h-full rounded-full", VERDICT_BAR[row.verdict])}
                style={{ width: `${percent}%` }}
              />
            </span>
          </div>
        </div>
      </Link>
    </li>
  );
}
