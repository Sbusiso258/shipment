/**
 * Shared state shape for the shipment forms.
 *
 * Outside the `"use server"` module for the same reason as
 * `checkpoint-form-state.ts`: every export from such a file becomes a callable
 * server endpoint, so Next refuses anything that is not an async function.
 */
export interface ShipmentFormState {
  ok: boolean;
  error: string | null;
  /**
   * Stages the shipment saved WITHOUT. The shipment insert and the stage
   * inserts are separate statements — PostgREST has no transaction — so a
   * partial save is possible and must be said out loud rather than smoothed
   * over. Silently dropping a stage is the one thing this product must not do.
   */
  unsavedStages?: string[];

  /**
   * What was typed, handed back so a rejected submission does not discard it.
   *
   * React 19 resets a `<form action={fn}>` once the action settles, success or
   * not, and these inputs are uncontrolled — so without this, one duplicate
   * reference threw away fourteen fields and the person started again.
   *
   * The repeatable stage rows are NOT in here. They are controlled React
   * state inside `ShipmentForm`, so they already survive both the reset and
   * the remount below.
   */
  values?: Record<string, string>;

  /**
   * Submission counter, used as the form's `key`. `defaultValue` is read once
   * at mount, so handing the values back is not enough on its own — the form
   * has to remount before React will look at them again.
   */
  attempt?: number;
}

export const EMPTY_FORM_STATE: ShipmentFormState = { ok: false, error: null };
