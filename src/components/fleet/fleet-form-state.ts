/**
 * Shared state shape for the fleet forms.
 *
 * Outside the `"use server"` module for the same reason as every other one:
 * each export from such a file becomes a callable server endpoint, so Next
 * refuses anything that is not an async function.
 */
export interface FleetFormState {
  ok: boolean;
  error: string | null;
}

export const EMPTY_FORM_STATE: FleetFormState = { ok: false, error: null };
