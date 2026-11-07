import type { Metadata } from "next";

import { Dashboard } from "@/components/board/dashboard";
import type { MappedShipment } from "@/components/board/tracking-map";
import type { RoutePoint } from "@/components/journey/route-map-gl";
import type { JourneyClock } from "@/lib/journey";
import { lastConfirmedPositions } from "@/lib/positions";
import { loadRecentCheckpoints } from "@/services/activity";
import { requireSession } from "@/services/bootstrap";
import { loadOversight, requestNow } from "@/services/oversight";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * The tile host without its style name.
 *
 * `NEXT_PUBLIC_MAP_STYLE_URL` points at one style; the panel needs to swap
 * between two, so the last segment comes off here. Anything that is not a
 * recognisable OpenFreeMap style URL is passed through untouched and the
 * toggle simply has nothing to switch between.
 */
function styleBaseFrom(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/^(.*\/styles)\/[^/]+\/?$/);
  return match ? match[1] : url;
}

export default async function DashboardPage() {
  const session = await requireSession();

  // The same instant the layout captured — `requestNow` is request-scoped, so
  // this is the identical number, which is what makes `loadOversight` hit its
  // cache instead of running every query a second time.
  const nowMs = requestNow();

  const clock: JourneyClock = {
    now: new Date(nowMs),
    timeZone: session.activeOrg.timezone,
    silenceThresholdDays: session.activeOrg.defaultSilenceThresholdDays,
  };

  const [{ rows }, checkpoints] = await Promise.all([
    loadOversight(nowMs, clock.timeZone, clock.silenceThresholdDays),
    loadRecentCheckpoints(),
  ]);

  // WHERE EACH LOAD ACTUALLY IS: the last stage confirmed at a known place.
  // Never a point between two stages — that would be a GPS fix nobody
  // reported, and it is the one fabrication this product must never ship.
  const positions = lastConfirmedPositions(checkpoints);

  const byShipment = new Map<string, RoutePoint[]>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.latitude === null || checkpoint.longitude === null) continue;
    const stages = byShipment.get(checkpoint.shipmentId) ?? [];
    stages.push({
      id: checkpoint.id,
      label: checkpoint.label,
      latitude: checkpoint.latitude,
      longitude: checkpoint.longitude,
      state: checkpoint.actualAt === null ? "pending" : "cleared",
      kind: checkpoint.id === positions.get(checkpoint.shipmentId)?.checkpointId
        ? "position"
        : "stage",
    });
    byShipment.set(checkpoint.shipmentId, stages);
  }

  const mapped: MappedShipment[] = rows
    .filter((row) => row.shipment.cancelledAt === null)
    .map((row) => ({
      id: row.shipment.id,
      reference: row.shipment.reference,
      verdict: row.verdict,
      originName: row.originName,
      destinationName: row.destinationName,
      position: positions.get(row.shipment.id) ?? null,
      stages: byShipment.get(row.shipment.id) ?? [],
      origin:
        row.originPoint?.latitude != null && row.originPoint.longitude != null
          ? { latitude: row.originPoint.latitude, longitude: row.originPoint.longitude }
          : null,
      destination:
        row.destinationPoint?.latitude != null &&
        row.destinationPoint.longitude != null
          ? {
              latitude: row.destinationPoint.latitude,
              longitude: row.destinationPoint.longitude,
            }
          : null,
    }));

  return (
    <main className="mx-auto flex w-full max-w-[110rem] flex-1 flex-col gap-list px-4 py-4 lg:min-h-0 lg:overflow-hidden">
      <Dashboard
        rows={rows}
        mapped={mapped}
        clock={clock}
        styleBase={styleBaseFrom(process.env.NEXT_PUBLIC_MAP_STYLE_URL)}
      />
    </main>
  );
}
