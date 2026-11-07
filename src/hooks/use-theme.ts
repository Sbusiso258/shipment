"use client";

import { useSyncExternalStore } from "react";

/**
 * The applied theme, read from the DOM rather than from React state.
 *
 * THE CLASS ON `<html>` IS THE SINGLE SOURCE OF TRUTH. A pre-paint script in
 * the root layout applies it before React exists, so any React state holding
 * a second copy starts out possibly wrong and can drift from what is actually
 * painted. `useSyncExternalStore` over a `MutationObserver` means there is
 * only ever one answer, and it is the one on screen.
 *
 * Dark is the default, so the class is `.light` — its ABSENCE means dark. See
 * the note at the top of globals.css for why that polarity.
 */

const STORAGE_KEY = "shipment-oversight:theme:v1";

export type Theme = "dark" | "light";

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

function getSnapshot(): Theme {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

/**
 * Server render and the hydration pass both get "dark" — the documented
 * default. A light-preferring visitor sees one frame of the toggle showing
 * dark before it corrects, which is why `theme-toggle.tsx` renders a
 * same-sized placeholder until it has mounted rather than an icon that could
 * contradict the page.
 */
function getServerSnapshot(): Theme {
  return "dark";
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function setTheme(next: Theme) {
    document.documentElement.classList.toggle("light", next === "light");

    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private windows and blocked site data both throw. The theme still
      // applies for this visit; it simply will not be remembered.
    }
  }

  return { theme, setTheme, toggle: () => setTheme(theme === "light" ? "dark" : "light") };
}
