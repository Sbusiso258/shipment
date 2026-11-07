"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { needsAttention, type BoardSummary } from "@/lib/board";
import type { JourneyClock, ShipmentVerdict } from "@/lib/journey";

import { ShipmentCard } from "./shipment-card";

/**
 * The shipment list, worst first.
 *
 * The filter lives in the URL and is read during render, so a filtered board
 * is linkable, survives a refresh and works with the back button. It is set
 * from the header's status cluster — the attention tiles that used to sit
 * above this list were removed at the owner's request, and the cluster is now
 * the way in.
 */
export function OversightBoard({
  summary,
  clock,
}: {
  summary: BoardSummary;
  clock: JourneyClock;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();

  const filter = searchParams.get("show");

  function clearFilter() {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("show");
    const query = next.toString();
    router.replace(query ? `?${query}` : "?", { scroll: false });
  }

  const visible = filter
    ? summary.rows.filter((row) => row.verdict === (filter as ShipmentVerdict))
    : summary.rows;

  const attention = summary.rows.filter((row) => needsAttention(row.verdict));

  return (
    <section className="flex flex-col gap-list">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-small font-medium text-ink-600">
          {filter ? "Filtered" : "All shipments"}
        </h2>

        <p className="flex items-center gap-2 text-micro text-ink-400">
          <span>
            {visible.length} of {summary.rows.length}
            {!filter && attention.length > 0
              ? ` · ${attention.length} needing attention`
              : null}
          </span>

          {filter ? (
            <button
              type="button"
              onClick={clearFilter}
              className="rounded-control px-1.5 py-0.5 text-marine-200 hover:bg-ink-100"
            >
              Clear
            </button>
          ) : null}
        </p>
      </header>

      {visible.length === 0 ? (
        <p className="rounded-panel border border-dashed border-ink-200 px-4 py-10 text-center text-ink-600">
          {filter ? "Nothing in this state right now." : "No shipments yet."}
        </p>
      ) : (
        <ol className="grid grid-cols-1 gap-list xl:grid-cols-2">
          {visible.map((row) => (
            <ShipmentCard
              key={row.shipment.id}
              row={row}
              clock={clock}
              href={`/shipments/${row.shipment.id}`}
            />
          ))}
        </ol>
      )}

      {/* Said plainly when it is true. A board whose good news is only the
          absence of red makes people hunt for problems that are not there. */}
      {attention.length === 0 && summary.rows.length > 0 && !filter ? (
        <p className="rounded-control bg-ontime-bg px-3 py-2 text-small text-ontime">
          Nothing needs attention right now.
        </p>
      ) : null}
    </section>
  );
}
