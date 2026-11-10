/**
 * Shared state shape for the location forms.
 *
 * Outside the `"use server"` module for the same reason as
 * `checkpoint-form-state.ts`: every export from such a file becomes a callable
 * server endpoint, so Next refuses anything that is not an async function.
 */
export interface LocationFormState {
  ok: boolean;
  error: string | null;

  /**
   * What was typed, handed back so a failed submission does not discard it.
   *
   * REACT 19 RESETS A `<form action={fn}>` ONCE THE ACTION COMPLETES, whether
   * it succeeded or not. Every input here is uncontrolled, so without this the
   * person loses everything they entered and gets one red line in exchange.
   *
   * Plain strings keyed by field name, because that is what `defaultValue`
   * wants and what `FormData` gives — no parsing on the way out and none on
   * the way back in.
   */
  values?: Record<string, string>;

  /**
   * Submission counter, used as the form's `key`.
   *
   * Changing `defaultValue` on an input that is already mounted does nothing —
   * React reads it once, at mount. So restoring the values also requires
   * remounting the form, and this is what tells React to. The same idiom is
   * already used in `panel-composer.tsx`.
   */
  attempt?: number;
}

export const EMPTY_FORM_STATE: LocationFormState = { ok: false, error: null };
