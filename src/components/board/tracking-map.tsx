"use client";

import { useState } from "react";
import { Layers, MapPin } from "lucide-react";

import { RouteMap } from "@/components/journey/route-map";
import type { RoutePoint } from "@/components/journey/route-map-gl";
import type { ShipmentVerdict } from "@/lib/journey";
import type { ShipmentPosition } from "@/lib/positions";
import { cn } from "@/lib/utils";

/**
 * Where the loads are.
 *
 * EVERY PIN IS A CONFIRMED CHECKPOINT. The mockup draws a truck partway down
 * the N1 and captions the panel "real-time"; this product has no live feed,
 * and a dot between two stages is a GPS fix nobody reported. `AGENTS.md`
 * forbids it, and the day a customer works out the dot was a guess, every
 * other number on the page becomes a guess too.
 *
 * So the truck glyph is the mockup's, and it sits on the last stage somebody
 * actually confirmed — with a caption that says exactly that. The picture is
 * the same; the claim is one the product can keep.
 *
 * NO SATELLITE LAYER, either. Google needs a billing account from the first
 * request and forbids storing coordinates, which this schema does; Esri and
 * MapTiler need a licence or a key for a product that is sold. The toggle
 * switches between two free OpenFreeMap styles instead.
 */

export interface MappedShipment {
  id: string;
  reference: string;
  verdict: ShipmentVerdict;
  originName: string;
  destinationName: string;
  position: ShipmentPosition | null;
  /** The shipment's own stages, for when it is the one being looked at. */
  stages: RoutePoint[];
  origin: { latitude: number; longitude: number } | null;
  destination: { latitude: number; longitude: number } | null;
}

const VERDICT_STATE: Record<ShipmentVerdict, RoutePoint["state"]> = {
  exception: "exception",
  late: "overdue",
  at_risk: "overdue",
  silent: "pending",
  on_track: "current",
  delivered: "cleared",
  delivered_late: "overdue",
  cancelled: "skipped",
};

/** Two real styles, both keyless and both on the configured host. */
const STYLES = [
  { id: "dark", label: "Dark" },
  { id: "liberty", label: "Streets" },
] as const;

type StyleId = (typeof STYLES)[number]["id"];

export function TrackingMap({
  shipments,
  selectedId,
  onSelect,
  styleBase,
}: {
  shipments: MappedShipment[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /**
   * The tile host, without a style name — `NEXT_PUBLIC_MAP_STYLE_URL` with
   * its last segment dropped. Null means no tile provider is configured, and
   * the schematic fallback renders instead.
   */
  styleBase: string | null;
}) {
  const [style, setStyle] = useState<StyleId>("dark");

  const selected = shipments.find((s) => s.id === selectedId) ?? null;

  // All of them: one truck each, at the last place each was confirmed. No
  // line, because a polyline through unrelated loads is a line nobody drove.
  const overview: RoutePoint[] = shipments
    .filter((s) => s.position !== null)
    .map((s) => ({
      id: s.id,
      label: s.reference,
      latitude: s.position!.latitude,
      longitude: s.position!.longitude,
      state: VERDICT_STATE[s.verdict],
      kind: "position" as const,
      caption: s.reference,
    }));

  // One shipment: its confirmed stages, plus labelled pins at both ends.
  const detail: RoutePoint[] = selected
    ? [
        ...(selected.origin
          ? [
              {
                id: `${selected.id}:origin`,
                label: selected.originName,
                latitude: selected.origin.latitude,
                longitude: selected.origin.longitude,
                state: "cleared" as const,
                kind: "origin" as const,
                caption: `${selected.originName} (Pickup)`,
              },
            ]
          : []),
        ...selected.stages,
        ...(selected.destination
          ? [
              {
                id: `${selected.id}:destination`,
                label: selected.destinationName,
                latitude: selected.destination.latitude,
                longitude: selected.destination.longitude,
                state: "pending" as const,
                kind: "destination" as const,
                caption: `${selected.destinationName} (Delivery)`,
              },
            ]
          : []),
      ]
    : [];

  const points = selected ? detail : overview;
  const positioned = overview.length;

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-panel border border-ink-200 bg-paper shadow-panel">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-panel py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-control bg-marine-100">
            <MapPin aria-hidden className="size-4 text-marine-200" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-lead font-semibold text-ink-950">
              {selected ? selected.reference : "Shipment tracking"}
            </h2>
            {/* The claim, stated every time, and never "live" or
                "real-time" — nothing feeds this but confirmed stages. */}
            <p className="truncate text-micro text-ink-400">
              {selected
                ? `Pickup to delivery. The truck is the last stage confirmed.`
                : `Each load at the last stage confirmed for it · ${positioned} of ${shipments.length} placed`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {selected ? (
            <button
              type="button"
              onClick={() => onSelect(null)}
              className="rounded-control px-2 py-1 text-small text-marine-200 hover:bg-ink-100"
            >
              Show all
            </button>
          ) : null}

          <div
            role="radiogroup"
            aria-label="Basemap"
            className="flex items-center gap-0.5 rounded-control border border-ink-200 bg-canvas p-0.5"
          >
            {STYLES.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={style === option.id}
                onClick={() => setStyle(option.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-control px-2.5 py-1 text-small transition-colors",
                  style === option.id
                    ? "bg-marine-700 text-marine-on"
                    : "text-ink-600 hover:bg-ink-100"
                )}
              >
                <Layers aria-hidden className="size-3.5" />
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 px-panel pb-panel">
        <RouteMap
          points={points}
          selectedId={null}
          onSelect={(id) => {
            // Clicking a truck selects that shipment. Clicking a stage of the
            // one already open does nothing — there is nowhere further in.
            if (!selected) onSelect(id);
          }}
          styleUrl={styleBase ? `${styleBase}/${style}` : null}
          connect={selected !== null}
          fitKey={selected ? selected.id : `all:${overview.length}`}
          emptyMessage={
            shipments.length === 0
              ? "No shipments yet. Record one and it appears here."
              : "No stage has been confirmed at a known place yet. Confirm one and the load appears on the map."
          }
        />
      </div>
    </section>
  );
}
