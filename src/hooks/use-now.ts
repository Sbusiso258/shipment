"use client";

import { useSyncExternalStore } from "react";

/**
 * The current instant, for the header clock.
 *
 * This is the one place in the app allowed to read the clock on the client,
 * and it is carefully arranged so it cannot cause the bug the rest of the
 * codebase avoids by banning it.
 *
 * THE SERVER'S INSTANT IS THE SERVER SNAPSHOT. The page captures `now` once
 * when it renders and passes it in; `getServerSnapshot` returns exactly that.
 * React calls it during the server render AND during hydration, so both
 * produce identical markup and there is no mismatch. Only afterwards does the
 * live value take over, as an ordinary re-render.
 *
 * THE SNAPSHOT IS MINUTE-GRANULAR WHILE THE INTERVAL IS ONE SECOND. A plain
 * 60-second interval drifts, and after a laptop sleeps it shows a stale time
 * until the next tick. Polling every second but truncating to the minute means
 * the component re-renders once a minute and re-aligns immediately on resume.
 *
 * Time is genuinely external state, which is why it belongs behind
 * `useSyncExternalStore` rather than in `useState` plus an effect.
 */

const MINUTE = 60_000;

function truncateToMinute(ms: number): number {
  return Math.floor(ms / MINUTE) * MINUTE;
}

let current = truncateToMinute(Date.now());
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick() {
  const next = truncateToMinute(Date.now());
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);

  if (!timer) {
    // One interval for the whole app, however many clocks are mounted.
    timer = setInterval(tick, 1000);
  }

  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return current;
}

/**
 * @param serverNowMs the instant the server captured, in epoch milliseconds.
 *   Pass the same value the rest of the page was rendered against.
 */
export function useNow(serverNowMs: number): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => serverNowMs);
}
