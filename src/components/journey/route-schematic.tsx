"use client";

import type { CheckpointState } from "@/lib/journey";
import { cn } from "@/lib/utils";

import type { RoutePoint } from "./route-map-gl";

/**
 * The route with no basemap: real coordinates on a plain projection of the
 * South African bounding box.
 *
 * Not a placeholder. It renders the same points, with the same selection
 * behaviour, and it has no network dependency at all — so the journey view
 * works before a tile provider is configured, when one is unreachable, and in
 * print, which customers will use.
 *
 * Equirectangular, deliberately. Over a country this size the distortion is
 * small, and the alternative is shipping a projection library to draw nine
 * dots.
 */

const STATE_COLOUR: Record<CheckpointState, string> = {
  cleared: "var(--status-ontime)",
  current: "var(--marine-700)",
  pending: "var(--ink-400)",
  overdue: "var(--status-late)",
  skipped: "var(--ink-200)",
  exception: "var(--status-exception)",
};

const WIDTH = 400;
const HEIGHT = 320;
const PAD = 28;

export function RouteSchematic({
  points,
  selectedId,
  onSelect,
}: {
  points: RoutePoint[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  // Fit to the points themselves rather than the whole country: a Johannesburg
  // to Pretoria run would otherwise be two dots touching in the middle of an
  // empty rectangle.
  const lats = points.map((p) => p.latitude);
  const lons = points.map((p) => p.longitude);
  const span = {
    latMin: Math.min(...lats),
    latMax: Math.max(...lats),
    lonMin: Math.min(...lons),
    lonMax: Math.max(...lons),
  };

  // A single point, or a perfectly straight run, has zero extent in one axis
  // and would divide by zero. Give it a minimum window.
  const MIN_SPAN = 1.2;
  const latRange = Math.max(span.latMax - span.latMin, MIN_SPAN);
  const lonRange = Math.max(span.lonMax - span.lonMin, MIN_SPAN);
  const latMid = (span.latMax + span.latMin) / 2;
  const lonMid = (span.lonMax + span.lonMin) / 2;

  const project = (lat: number, lon: number) => ({
    x: PAD + ((lon - (lonMid - lonRange / 2)) / lonRange) * (WIDTH - PAD * 2),
    // y is inverted: latitude increases northwards, SVG y increases downwards.
    y: PAD + (((latMid + latRange / 2) - lat) / latRange) * (HEIGHT - PAD * 2),
  });

  const projected = points.map((p) => ({ ...p, ...project(p.latitude, p.longitude) }));
  const path = projected.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  return (
    <figure className="flex h-full flex-col rounded-panel border border-ink-200 bg-paper p-3">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full flex-1"
        role="img"
        aria-label={`Route through ${points.map((p) => p.label).join(", ")}`}
      >
        <polyline
          points={path}
          fill="none"
          stroke="var(--marine-700)"
          strokeWidth={1.5}
          strokeOpacity={0.45}
          strokeDasharray="4 3"
          strokeLinecap="round"
        />

        {projected.map((p) => {
          const selected = p.id === selectedId;
          return (
            <g key={p.id}>
              {selected ? (
                <circle cx={p.x} cy={p.y} r={11} fill="var(--marine-500)" opacity={0.18} />
              ) : null}
              <circle
                cx={p.x}
                cy={p.y}
                r={selected ? 6.5 : 5}
                fill={STATE_COLOUR[p.state]}
                stroke="var(--paper)"
                strokeWidth={2}
                className="cursor-pointer"
                onClick={() => onSelect(p.id)}
              />
            </g>
          );
        })}
      </svg>

      <figcaption
        className={cn(
          "mt-2 text-center text-micro text-ink-400",
          "border-t border-ink-100 pt-2"
        )}
      >
        Positions are real; the background is not a map. Set
        {" "}
        <code className="font-code">NEXT_PUBLIC_MAP_STYLE_URL</code> for the basemap.
      </figcaption>
    </figure>
  );
}
