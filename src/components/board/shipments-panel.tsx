"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronRight, Search, Truck } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  countByVerdict,
  filterRows,
  sortByTrouble,
  stagesLabel,
  type BoardRow,
} from "@/lib/board";
import type { JourneyClock, ShipmentVerdict } from "@/lib/journey";
import { cn } from "@/lib/utils";
import { verdictLabel } from "@/lib/verdicts";

/**
 * The shipment list beside the map.
 *
 * A row click and the chevron do DIFFERENT THINGS, which is the point of
 * having both: the row shows that load on the map next to it, and the chevron
 * opens its journey. One is "look at this", the other is "go to this".
 *
 * Search and filter are local state over rows already loaded. The board
 * fetches every open shipment anyway, so a round trip per keystroke would buy
 * nothing — and `filterRows` lives in `src/lib/board.ts` with tests, because
 * "does this row match" is a judgement rather than markup.
 */

/**
 * Colour only. The LABEL comes from `src/lib/verdicts.ts`, which is the single
 * source of truth — this map used to carry its own and drifted away from
 * `verdict-badge.tsx`, calling `on_track` "In transit".
 */
const VERDICT_PILL: Record<ShipmentVerdict, string> = {
  exception: "bg-exception-bg text-exception",
  late: "bg-late-bg text-late",
  at_risk: "bg-late-bg text-late",
  silent: "bg-silent-bg text-silent",
  on_track: "bg-ontime-bg text-ontime",
  delivered: "bg-delivered-bg text-delivered",
  delivered_late: "bg-late-bg text-late",
  cancelled: "bg-ink-100 text-ink-600",
};

const VERDICT_ICON: Record<ShipmentVerdict, string> = {
  exception: "bg-exception/15 text-exception",
  late: "bg-late/15 text-late",
  at_risk: "bg-late/15 text-late",
  silent: "bg-silent/15 text-silent",
  on_track: "bg-marine-700/15 text-marine-200",
  delivered: "bg-delivered/15 text-delivered",
  delivered_late: "bg-late/15 text-late",
  cancelled: "bg-ink-100 text-ink-400",
};

/**
 * An ETA that was RECORDED, never one derived from the other stages.
 *
 * `plannedDeliveryAt` is an instant somebody entered. Falling back to the
 * promised day is honest because it is also something somebody committed to —
 * it is just a day rather than a time, so it is rendered as one.
 */
function etaLabel(row: BoardRow, timeZone: string): string {
  const { shipment } = row;

  if (shipment.deliveredAt) {
    return `Delivered ${new Intl.DateTimeFormat("en-ZA", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(shipment.deliveredAt))}`;
  }

  if (shipment.plannedDeliveryAt) {
    return `ETA ${new Intl.DateTimeFormat("en-ZA", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(shipment.plannedDeliveryAt))}`;
  }

  if (shipment.promisedDeliveryDate) {
    return `Promised ${shipment.promisedDeliveryDate}`;
  }

  // Not "ETA unknown" — nobody has made a promise, which is different from
  // having made one we have lost.
  return "No delivery time recorded";
}

export function ShipmentsPanel({
  rows,
  clock,
  selectedId,
  onSelect,
}: {
  rows: BoardRow[];
  clock: JourneyClock;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [verdict, setVerdict] = useState<ShipmentVerdict | "">("");

  const counts = countByVerdict(rows);
  const visible = sortByTrouble(
    filterRows(rows, { query, verdict: verdict === "" ? null : verdict }),
    clock
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-panel border border-ink-200 bg-paper shadow-panel">
      <header className="shrink-0 border-b border-ink-200 px-panel py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-control bg-marine-100">
              <Truck aria-hidden className="size-4 text-marine-200" />
            </span>
            <h2 className="truncate text-lead font-semibold text-ink-950">
              Shipments
            </h2>
          </div>

          <Link
            href="/shipments"
            className="flex shrink-0 items-center gap-1 rounded-control px-2 py-1 text-small text-marine-200 hover:bg-ink-100"
          >
            View all
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by reference or place…"
              aria-label="Search shipments"
              className="pl-9"
            />
          </div>

          <select
            value={verdict}
            onChange={(event) =>
              setVerdict(event.target.value as ShipmentVerdict | "")
            }
            aria-label="Filter by status"
            className="h-10 rounded-control border border-ink-200 bg-paper px-3 text-small text-ink-950"
          >
            <option value="">All statuses</option>
            {(Object.keys(VERDICT_PILL) as ShipmentVerdict[])
              .filter((key) => counts[key] > 0)
              .map((key) => (
                <option key={key} value={key}>
                  {verdictLabel(key)} ({counts[key]})
                </option>
              ))}
          </select>
        </div>
      </header>

      {visible.length === 0 ? (
        <p className="px-panel py-10 text-center text-small text-ink-400">
          {rows.length === 0
            ? "No shipments yet."
            : "Nothing matches that. Clear the search or the status filter."}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {visible.map((row) => {
            const pillClass = VERDICT_PILL[row.verdict];
            const current = row.shipment.id === selectedId;

            return (
              <li key={row.shipment.id}>
                <div
                  className={cn(
                    "mb-1 flex items-center gap-3 rounded-panel border px-3 py-2.5 transition-colors",
                    current
                      ? "border-marine-500 bg-marine-100/40"
                      : "border-transparent bg-paper-raised hover:border-ink-200"
                  )}
                >
                  {/* The row shows it on the map; the chevron opens it. Two
                      buttons rather than one, because they are two verbs. */}
                  <button
                    type="button"
                    onClick={() => onSelect(current ? null : row.shipment.id)}
                    aria-pressed={current}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <span
                      className={cn(
                        "grid size-10 shrink-0 place-items-center rounded-control",
                        VERDICT_ICON[row.verdict]
                      )}
                    >
                      <Truck aria-hidden className="size-5" />
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-code text-body font-semibold text-ink-950">
                        {row.shipment.reference}
                      </span>
                      <span className="block truncate text-micro text-ink-400">
                        {row.originName} → {row.destinationName}
                      </span>
                      <span className="block truncate text-micro text-ink-400">
                        {etaLabel(row, clock.timeZone)} · {stagesLabel(row.shipment)}
                      </span>
                    </span>
                  </button>

                  <span className="flex shrink-0 items-center gap-2">
                    <span
                      className={cn(
                        "rounded-control px-2 py-0.5 text-micro font-medium",
                        pillClass
                      )}
                    >
                      {verdictLabel(row.verdict)}
                    </span>

                    <Link
                      href={`/shipments/${row.shipment.id}`}
                      aria-label={`Open ${row.shipment.reference}`}
                      className="grid size-8 place-items-center rounded-control text-ink-400 hover:bg-ink-100 hover:text-ink-950"
                    >
                      <ChevronRight aria-hidden className="size-4" />
                    </Link>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
