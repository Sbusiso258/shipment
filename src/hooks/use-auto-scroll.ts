"use client";

import { useEffect, useRef } from "react";

/**
 * Drifts a scrolling element downwards on its own, like a wall display.
 *
 * It PAUSES the moment anyone shows interest — pointer over it, keyboard
 * focus inside it, or a manual scroll — and resumes a few seconds after they
 * stop. Without that it is unusable: you cannot read something that is moving
 * away from you, and you certainly cannot click a link on it.
 *
 * It also does nothing at all when the content fits, when the tab is hidden,
 * or when the reader has asked for reduced motion. A page that animates
 * itself in a background tab is just burning battery.
 */
export function useAutoScroll<T extends HTMLElement>({
  /**
   * Pixels per second. Set to be noticeably quick, at the owner's request —
   * this is a wall-display pace rather than a reading pace, which is fine
   * precisely because it stops the moment anyone interacts with it.
   */
  speed = 60,
  /** How long to wait after someone stops interacting. */
  resumeAfterMs = 4000,
  enabled = true,
}: {
  speed?: number;
  resumeAfterMs?: number;
  enabled?: boolean;
} = {}) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduceMotion.matches) return;

    let paused = false;
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;
    let frame: number | null = null;
    let last: number | null = null;
    // Sub-pixel movement accumulates here; scrollTop is an integer, so
    // assigning 0.3px repeatedly would otherwise never move anything.
    let carried = 0;

    function pause() {
      paused = true;
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => {
        paused = false;
      }, resumeAfterMs);
    }

    function step(now: number) {
      frame = requestAnimationFrame(step);

      if (last === null) {
        last = now;
        return;
      }

      const elapsed = now - last;
      last = now;

      if (paused || document.hidden || !element) return;

      const overflow = element.scrollHeight - element.clientHeight;
      if (overflow <= 1) return;

      carried += (speed * elapsed) / 1000;
      const whole = Math.floor(carried);
      if (whole < 1) return;
      carried -= whole;

      // At the bottom, go back to the top rather than stopping. The newest
      // items are there, which is what somebody glancing at it wants.
      if (element.scrollTop >= overflow - 1) element.scrollTop = 0;
      else element.scrollTop += whole;
    }

    // `wheel` and `touchstart` rather than `scroll`: the scroll event fires
    // for our own movement too, which would pause it permanently on the first
    // frame.
    element.addEventListener("pointerenter", pause);
    element.addEventListener("wheel", pause, { passive: true });
    element.addEventListener("touchstart", pause, { passive: true });
    element.addEventListener("focusin", pause);

    frame = requestAnimationFrame(step);

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (resumeTimer) clearTimeout(resumeTimer);
      element.removeEventListener("pointerenter", pause);
      element.removeEventListener("wheel", pause);
      element.removeEventListener("touchstart", pause);
      element.removeEventListener("focusin", pause);
    };
  }, [speed, resumeAfterMs, enabled]);

  return ref;
}
