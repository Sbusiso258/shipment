"use client";

import { useSyncExternalStore } from "react";

import { attributePreference } from "./preference";

/**
 * How much information fits on screen.
 *
 * Changes panel padding, row height, gaps and the two list-level type steps —
 * and nothing else. Headings keep their size, so the page gets denser without
 * appearing to rescale. The values live in `globals.css` under
 * `[data-density="…"]`; nothing here knows what they are.
 */

export type Density = "small" | "medium" | "large";

const store = attributePreference<Density>({
  attribute: "data-density",
  storageKey: "shipment-oversight:density:v1",
  // Medium is the default and is represented by no attribute at all.
  fallback: "medium",
  isValid: (value): value is Density =>
    value === "small" || value === "medium" || value === "large",
});

export function useDensity() {
  const density = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  );

  return { density, setDensity: store.set };
}
