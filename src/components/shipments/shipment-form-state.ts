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
}

export const EMPTY_FORM_STATE: ShipmentFormState = { ok: false, error: null };
