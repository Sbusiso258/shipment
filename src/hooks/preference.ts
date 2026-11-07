"use client";

/**
 * The shared machinery behind theme, density and header visibility.
 *
 * All three are the same shape: a value applied to `<html>` before paint by
 * the script in the root layout, remembered in `localStorage`, and changed by
 * one control in the header.
 *
 * THE DOM IS THE SINGLE SOURCE OF TRUTH, in all three cases. The pre-paint
 * script runs before React exists, so any React state holding a second copy
 * starts out possibly wrong and can drift from what is actually painted.
 * Reading back through a `MutationObserver` means there is only ever one
 * answer, and it is the one on screen.
 *
 * Writing to `localStorage` is always wrapped: it throws in a private window
 * and when site data is blocked. The preference still applies for the visit;
 * it simply is not remembered.
 */

export interface PreferenceStore<T extends string> {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => T;
  getServerSnapshot: () => T;
  set: (value: T) => void;
}

/**
 * A preference held in an attribute on `<html>`, where one value is the
 * default and is represented by the attribute being ABSENT.
 */
export function attributePreference<T extends string>(options: {
  attribute: string;
  storageKey: string;
  /** The value meaning "default" — written as no attribute at all. */
  fallback: T;
  isValid: (value: string) => value is T;
}): PreferenceStore<T> {
  const { attribute, storageKey, fallback, isValid } = options;

  return {
    subscribe(onChange) {
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: [attribute],
      });
      return () => observer.disconnect();
    },

    getSnapshot() {
      const value = document.documentElement.getAttribute(attribute);
      return value && isValid(value) ? value : fallback;
    },

    // The server renders the default, and so does the hydration pass, so the
    // two agree. A non-default preference corrects itself on the first client
    // render — which is an ordinary re-render, not a mismatch.
    getServerSnapshot() {
      return fallback;
    },

    set(value) {
      if (value === fallback) {
        document.documentElement.removeAttribute(attribute);
      } else {
        document.documentElement.setAttribute(attribute, value);
      }

      try {
        window.localStorage.setItem(storageKey, value);
      } catch {
        // Private window or blocked site data. Applied, just not remembered.
      }
    },
  };
}
