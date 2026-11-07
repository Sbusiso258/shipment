"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the component has hydrated.
 *
 * For the narrow case where a component cannot render its real content on the
 * server without risking a mismatch — a control whose appearance depends on a
 * class the pre-paint script applied, for instance. Such a component renders a
 * same-sized placeholder until this returns true, so the layout never shifts
 * and the control never briefly contradicts the page.
 *
 * Implemented with `useSyncExternalStore` rather than the usual
 * `useState(false)` + `useEffect(() => setMounted(true))`. React 19 flags that
 * pattern (`react-hooks/set-state-in-effect`) and is right to: it renders
 * once, commits, then immediately re-renders. Here the two snapshots say it
 * directly — the server's answer is false, the client's is true — with no
 * state and no effect.
 *
 * Not a general escape hatch. Anything that CAN be rendered identically on
 * both sides should be, because content behind this flag is invisible until
 * JavaScript arrives.
 */

// Nothing ever changes after hydration, so the store never notifies.
const subscribe = () => () => {};

export function useMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}
