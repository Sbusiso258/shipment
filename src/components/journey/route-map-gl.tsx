"use client";

import { useEffect, useRef } from "react";
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";

import "maplibre-gl/dist/maplibre-gl.css";

import type { CheckpointState } from "@/lib/journey";

/**
 * What a marker IS, which decides how it is drawn.
 *
 * `position` is the one worth reading twice: it is the LAST STAGE CONFIRMED
 * for a load, drawn as a truck because that is what the reader is looking
 * for — never a point between two stages. A truck halfway down the N1 is a
 * GPS fix nobody reported, and `AGENTS.md` forbids it outright.
 */
export type MarkerKind = "stage" | "position" | "origin" | "destination";

export interface RoutePoint {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  state: CheckpointState;
  kind?: MarkerKind;
  /** Shown beside the pin, as the mockup's "Cape Town (Pickup)" callout. */
  caption?: string;
}

/**
 * The route, on a real map.
 *
 * ALL MapLibre contact lives in this one file. It touches `window` at import
 * time, so it is loaded through `next/dynamic` with `ssr: false` from
 * `route-map.tsx` — and note that `dynamic(..., { ssr: false })` is not
 * allowed in a Server Component, which is why that wrapper is also a client
 * file. This is the single most common way a map breaks an App Router build.
 *
 * `maplibre-gl` is used directly rather than through `react-map-gl`: the
 * wrapper pins MapLibre versions, has been slow to accept React 19, and buys
 * nothing for one static map.
 */

const STATE_COLOUR: Record<CheckpointState, string> = {
  cleared: "#15803d",
  current: "#11505f",
  pending: "#7d8a99",
  overdue: "#b45309",
  skipped: "#d5dbe2",
  exception: "#b91c1c",
};

/**
 * A truck, as an inline SVG path. Lucide's `Truck`, hand-inlined because this
 * file builds DOM nodes rather than React elements.
 */
const TRUCK_PATH =
  "M10 17h4V5H2v12h3m5 0a2 2 0 1 0 4 0m-4 0a2 2 0 1 1 4 0m-9 0a2 2 0 1 0 4 0" +
  "m-4 0a2 2 0 1 1 4 0M14 9h4l4 4v4h-3m-1 0a2 2 0 1 0-4 0";

/**
 * One marker, drawn according to what it is.
 *
 * Built as DOM rather than React because MapLibre markers take an element.
 * Everything here is `textContent`, never `innerHTML` with a value from the
 * database — a place name is somebody's input and this is the one spot in the
 * app where it would be parsed as markup.
 */
function buildMarker(point: RoutePoint): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.setAttribute("aria-label", point.caption ?? point.label);
  el.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;background:none;border:0;padding:0";

  const dot = document.createElement("span");
  const colour = STATE_COLOUR[point.state];

  if (point.kind === "position") {
    // The mockup's truck, sitting on the last stage that was confirmed.
    dot.style.cssText = [
      "display:grid",
      "place-items:center",
      "width:30px",
      "height:30px",
      "border-radius:9999px",
      "border:2px solid #ffffff",
      `background:${colour}`,
      `box-shadow:0 0 0 6px ${colour}33, 0 2px 6px rgb(13 17 23 / 0.45)`,
    ].join(";");

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "#ffffff");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", TRUCK_PATH);
    svg.appendChild(path);
    dot.appendChild(svg);
  } else if (point.kind === "origin" || point.kind === "destination") {
    dot.style.cssText = [
      "width:14px",
      "height:14px",
      "border-radius:9999px",
      "border:3px solid #ffffff",
      `background:${point.kind === "origin" ? "#15803d" : "#b91c1c"}`,
      "box-shadow:0 2px 6px rgb(13 17 23 / 0.45)",
    ].join(";");
  } else {
    dot.style.cssText = [
      "width:16px",
      "height:16px",
      "border-radius:9999px",
      "border:2px solid #ffffff",
      "box-shadow:0 1px 3px rgb(13 17 23 / 0.3)",
      `background:${colour}`,
    ].join(";");
  }

  el.appendChild(dot);

  // The callout beside the pin — "Cape Town (Pickup)" in the mockup.
  if (point.caption) {
    const label = document.createElement("span");
    label.textContent = point.caption;
    label.style.cssText = [
      "white-space:nowrap",
      "border-radius:6px",
      "padding:2px 6px",
      "font-size:11px",
      "font-weight:500",
      "color:#ffffff",
      "background:rgb(13 17 23 / 0.78)",
      "box-shadow:0 1px 3px rgb(13 17 23 / 0.4)",
    ].join(";");
    el.appendChild(label);
  }

  return el;
}

/** A line with no coordinates — used to blank the route without removing it. */
const EMPTY_LINE: GeoJSON.Feature<GeoJSON.LineString> = {
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates: [] },
};

export default function RouteMapGl({
  points,
  selectedId,
  onSelect,
  styleUrl,
  connect = true,
  fitKey,
}: {
  points: RoutePoint[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  styleUrl: string;
  /**
   * Whether to join the points with a line.
   *
   * True for one journey, where the order IS the route. False for many
   * shipments at once, where a polyline through unrelated loads would draw a
   * line nobody drove — the same objection as an interpolated position,
   * wearing a different shape.
   */
  connect?: boolean;
  /** What identifies this point set. `fitBounds` runs only when it changes. */
  fitKey?: string;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Map<string, maplibregl.Marker>>(new Map());
  /** The last point set the camera was fitted to. See the note below. */
  const fittedKey = useRef<string | undefined>(undefined);
  /** The basemap currently applied, so a swap happens once per change. */
  const appliedStyle = useRef<string>(styleUrl);
  /**
   * Resolves when the style has loaded. Camera calls made before that are
   * SILENTLY DROPPED — so the first click after a cold load does nothing,
   * roughly one time in three depending on network speed. That is the kind of
   * bug that gets dismissed as imagination, so every camera move awaits this.
   */
  const ready = useRef<Promise<void> | null>(null);

  // Create the map once. Not on every points change: re-creating it loses the
  // user's pan and zoom.
  useEffect(() => {
    if (!container.current || map.current) return;

    const instance = new maplibregl.Map({
      container: container.current,
      style: styleUrl,
      center: [25, -29], // roughly the middle of South Africa
      zoom: 4.2,
      attributionControl: { compact: false },
    });

    instance.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right"
    );
    // The locate button under the zoom controls. It asks the browser for
    // permission; refusing it is silent and leaves the rest of the map alone.
    instance.addControl(
      new maplibregl.GeolocateControl({ trackUserLocation: false }),
      "top-right"
    );
    map.current = instance;
    ready.current = new Promise((resolve) => instance.once("load", () => resolve()));

    // A container with a computed height of 0 renders a 0x0 map that never
    // recovers on its own — which happens whenever the grid collapses at a
    // breakpoint.
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container.current);

    // Captured here rather than read as `markers.current` in the cleanup: the
    // ref may point at a different Map by the time cleanup runs.
    const markerStore = markers.current;

    return () => {
      observer.disconnect();
      instance.remove();
      map.current = null;
      ready.current = null;
      markerStore.clear();
    };
    // Created ONCE. `styleUrl` is deliberately not a dependency: re-creating
    // the map to change basemap would throw away the reader's pan and zoom.
    // The effect below swaps the style in place instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Swap the basemap without rebuilding the map.
   *
   * THE TRAP: `setStyle` DISCARDS every custom source and layer. The route
   * line is one, so it has to be put back — and `load` does not fire a second
   * time, so the promise everything else awaits has to be re-armed against
   * the new style. Markers are DOM elements and survive untouched.
   *
   * Without this, the first toggle silently empties the map of its route and
   * nothing in the console says why.
   */
  useEffect(() => {
    const instance = map.current;
    if (!instance || appliedStyle.current === styleUrl) return;

    appliedStyle.current = styleUrl;

    ready.current = new Promise((resolve) => {
      const done = () => {
        if (!instance.isStyleLoaded()) return;
        instance.off("styledata", done);
        resolve();
      };
      instance.on("styledata", done);
    });

    instance.setStyle(styleUrl);
  }, [styleUrl]);

  // Draw the route line and the markers whenever the points change.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;

    let cancelled = false;

    ready.current.then(() => {
      if (cancelled || !map.current) return;

      const coordinates = points.map(
        (p) => [p.longitude, p.latitude] as [number, number]
      );

      // The line joins CONFIRMED and PLANNED stops in sequence. It is not a
      // road route and does not pretend to be one: drawing a snapped road path
      // would imply we know which roads were taken, and we do not.
      const line: GeoJSON.Feature<GeoJSON.LineString> = {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates },
      };

      const source = instance.getSource<maplibregl.GeoJSONSource>("route");
      if (source) {
        // An empty geometry rather than a removed layer: MapLibre keeps the
        // layer's paint and order, and toggling `connect` must not leave a
        // stale line behind.
        source.setData(connect ? line : EMPTY_LINE);
      } else if (connect && coordinates.length > 1) {
        instance.addSource("route", { type: "geojson", data: line });
        instance.addLayer({
          id: "route-line",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#11505f",
            "line-width": 2.5,
            "line-opacity": 0.5,
            "line-dasharray": [2, 1.5],
          },
        });
      }

      for (const marker of markers.current.values()) marker.remove();
      markers.current.clear();

      for (const point of points) {
        const el = buildMarker(point);
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          onSelect(point.id);
        });

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([point.longitude, point.latitude])
          .addTo(instance);
        markers.current.set(point.id, marker);
      }

      // Fit once per point SET, never on selection change: refitting on
      // selection makes the map lurch every time someone reads a row. With
      // `fitKey` the caller decides what counts as a new set — a dashboard
      // that refreshes every few seconds must not keep snapping the camera
      // back while somebody is reading one corner of it.
      if (coordinates.length > 0 && fittedKey.current !== fitKey) {
        fittedKey.current = fitKey;
        const bounds = coordinates.reduce(
          (acc, coord) => acc.extend(coord),
          new maplibregl.LngLatBounds(coordinates[0], coordinates[0])
        );
        instance.fitBounds(bounds, { padding: 56, maxZoom: 9, duration: 0 });
      }
    });

    return () => {
      cancelled = true;
    };
    // `styleUrl` is a dependency because `setStyle` above throws the route
    // layer away: this effect is what puts it back.
  }, [points, onSelect, connect, fitKey, styleUrl]);

  // The one legitimate effect in this feature: MapLibre is imperative and
  // cannot be told the camera declaratively.
  useEffect(() => {
    if (!selectedId || !ready.current) return;
    const point = points.find((p) => p.id === selectedId);
    if (!point) return;

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    ready.current.then(() => {
      const instance = map.current;
      if (!instance) return;
      const camera = { center: [point.longitude, point.latitude] as [number, number], zoom: 7 };
      if (reduceMotion) instance.jumpTo(camera);
      else instance.flyTo({ ...camera, duration: 600 });
    });
  }, [selectedId, points]);

  return (
    // An explicit aspect ratio, because Leaflet-style percentage heights
    // inside an unsized parent give a zero-height map and a blank panel.
    <div
      ref={container}
      className="aspect-[4/3] w-full overflow-hidden rounded-panel border border-ink-200 lg:aspect-auto lg:h-full lg:min-h-[28rem]"
    />
  );
}
