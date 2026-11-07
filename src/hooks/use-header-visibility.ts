"use client";

import { useSyncExternalStore } from "react";

import { attributePreference } from "./preference";

/**
 * Whether the top bar is showing.
 *
 * A durable preference, not component state: someone who collapses the header
 * to get more board on screen expects it to stay collapsed after a reload.
 * `useState` in the layout would survive a soft navigation and nothing else.
 *
 * The collapse itself is pure CSS — `[data-header="hidden"]` sets
 * `--header-h` to zero and everything sized in `h-header` follows. The header
 * is collapsed, never unmounted: removing it would drop keyboard focus into
 * nowhere, along with the control that brings it back.
 */

export type HeaderState = "visible" | "hidden";

const store = attributePreference<HeaderState>({
  attribute: "data-header",
  storageKey: "shipment-oversight:header:v1",
  fallback: "visible",
  isValid: (value): value is HeaderState =>
    value === "visible" || value === "hidden",
});

export function useHeaderVisibility() {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  );

  return {
    hidden: state === "hidden",
    setHidden: (hidden: boolean) => store.set(hidden ? "hidden" : "visible"),
    toggle: () => store.set(state === "hidden" ? "visible" : "hidden"),
  };
}
