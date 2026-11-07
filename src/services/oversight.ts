import { cache } from "react";

import type { JourneyClock } from "@/lib/journey";

import { loadBoard, type BoardData } from "./shipments";

/**
 * The instant this request is being rendered at.
 *
 * Cached, so the layout and the page get the SAME number rather than two
 * `Date.now()` calls milliseconds apart. That matters twice over: the header
 * clock and the board's lateness judgements must agree, and `loadOversight`
 * below is keyed on it — two nearly-equal values would miss the cache and
 * quietly run every query twice.
 */
export const requestNow = cache((): number => Date.now());

/**
 * The board, loaded once per request.
 *
 * Both the shell (for the status cluster) and the page (for the board itself)
 * need these rows, and Next does not deduplicate Supabase calls — without
 * this they would be three queries each, twice. React's `cache()` memoises
 * for the lifetime of one request.
 *
 * THE ARGUMENTS ARE PRIMITIVES, deliberately. `cache()` keys on argument
 * identity, so passing a `JourneyClock` object would miss every time: the
 * layout and the page each construct their own, and two structurally equal
 * objects are not the same object. Passing the epoch and two scalars means
 * the key actually matches.
 */
export const loadOversight = cache(
  async (
    nowMs: number,
    timeZone: string,
    silenceThresholdDays: number
  ): Promise<BoardData> => {
    const clock: JourneyClock = {
      now: new Date(nowMs),
      timeZone,
      silenceThresholdDays,
    };

    return loadBoard(clock);
  }
);
