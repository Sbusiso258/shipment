"use client";

import { useSyncExternalStore } from "react";

import { attributePreference } from "./preference";

/**
 * Whether the sidebar is showing labels or only icons.
 *
 * The same shape as `useHeaderVisibility`, and durable for the same reason:
 * somebody who collapses the rail to get more map on screen expects it to
 * stay collapsed after a reload.
 *
 * The collapse is pure CSS — `[data-nav="rail"]` sets `--sidebar-w` to an
 * icon width and everything sized in `w-sidebar` follows. The sidebar is
 * NARROWED, never unmounted: the links keep their tab order, and the control
 * that widens it again stays reachable.
 */

export type NavState = "full" | "rail";

const store = attributePreference<NavState>({
  attribute: "data-nav",
  storageKey: "shipment-oversight:nav:v1",
  // "rail" is the default, so FULL is the value written as an attribute and
  // rail is the absence of one. The pre-paint script and this must agree on
  // which is which, or the first click after a reload appears to do nothing.
  fallback: "rail",
  isValid: (value): value is NavState => value === "full" || value === "rail",
});

export function useNavRail() {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  );

  return {
    rail: state === "rail",
    toggle: () => store.set(state === "rail" ? "full" : "rail"),
  };
}
