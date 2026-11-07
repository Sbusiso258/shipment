import { Suspense } from "react";

import type { Metadata } from "next";
import Link from "next/link";

import { OversightBoard } from "@/components/board/oversight-board";
import { Button } from "@/components/ui/button";
import { boardSummary } from "@/lib/board";
import type { JourneyClock } from "@/lib/journey";
import { canEditShipments } from "@/lib/roles";
import { requireSession } from "@/services/bootstrap";
import { loadOversight, requestNow } from "@/services/oversight";

export const metadata: Metadata = { title: "Shipments" };

/**
 * Every load, worst first.
 *
 * The board used to be half the dashboard. It is a list that wants width, and
 * the dashboard now has a map in that space — so it lives here, where it can
 * use the whole screen.
 */
export default async function ShipmentsPage() {
  const session = await requireSession();
  const nowMs = requestNow();

  const clock: JourneyClock = {
    now: new Date(nowMs),
    timeZone: session.activeOrg.timezone,
    silenceThresholdDays: session.activeOrg.defaultSilenceThresholdDays,
  };

  const { rows } = await loadOversight(
    nowMs,
    clock.timeZone,
    clock.silenceThresholdDays
  );

  return (
    <main className="mx-auto flex w-full max-w-[110rem] flex-1 flex-col gap-5 px-4 py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-title font-semibold text-ink-950">Shipments</h1>
          <p className="mt-1 text-ink-600">
            Everything {session.activeOrg.name} is moving, with whatever is
            late or stuck at the top.
          </p>
        </div>

        {canEditShipments(session.activeRole) ? (
          <Button asChild>
            <Link href="/shipments/new">New shipment</Link>
          </Button>
        ) : null}
      </header>

      {rows.length === 0 ? (
        <div className="rounded-panel border border-dashed border-ink-200 px-4 py-16 text-center">
          <p className="text-lead text-ink-950">No shipments yet</p>
          <p className="mx-auto mt-1 max-w-sm text-small text-ink-400">
            Record one and it appears here, on the dashboard map, and in the
            live feed.
          </p>
        </div>
      ) : (
        // The filter lives in the URL, which needs a boundary on a page that
        // can be prerendered.
        <Suspense
          fallback={
            <div className="h-64 animate-pulse rounded-panel border border-ink-200 bg-paper" />
          }
        >
          <OversightBoard summary={boardSummary(rows, clock)} clock={clock} />
        </Suspense>
      )}
    </main>
  );
}
